/**
 * Drive time from home to a destination — "typical first, live when it matters".
 *
 * 1. Every destination has a TYPICAL drive time you set once (DRIVE_TYPICAL_MIN).
 *    That alone gives the board a "leave by" for every train, with no outside
 *    service involved and nothing that can fail.
 * 2. LIVE traffic from the Google Routes API is an optional refinement on top,
 *    asked for only during the hours when someone is actually about to leave
 *    (DRIVE_LIVE_HOURS), at most once per destination per 10 minutes across all
 *    server instances. If Google is unconfigured, down, over quota, or the key
 *    is dead, the board quietly uses the typical time and says so.
 *
 * Callers get { sec, source } so screens can mark a typical time ("~16 min").
 *
 * Environment (all optional; set in Vercel, never in the repo):
 *   HOME_ADDRESS         where drives start — only ever sent to Google
 *   GOOGLE_MAPS_API_KEY  a Google Cloud key with the Routes API enabled
 *   DRIVE_TYPICAL_MIN    typical minutes per destination, e.g. "92=16,18=10,commute=15"
 *                        (keys: GTFS stop id of a station, or "commute" for the school run)
 *   DRIVE_LIVE_HOURS     New York hours to ask for live traffic, default "5-11"
 *
 * Cost bound: 6 hours x 6 ten-minute slots x 3 destinations = 108 Google calls
 * a day at most, however many screens are polling.
 */

import { unstable_cache } from "next/cache";

export type DriveEstimate = { sec: number; source: "live" | "typical" };

type LatLon = { lat: number; lon: number };

/** A Google Routes "waypoint" destination — a coordinate or an address. */
type Destination =
  | { location: { latLng: { latitude: number; longitude: number } } }
  | { address: string };

const SLOT_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 2500;

// --- configuration (read at call time so tests and env changes take effect) ---

function homeAddress(): string | null {
  return process.env.HOME_ADDRESS?.trim() || null;
}

/** "92=16,18=10,commute=15" -> Map { "92" => 16, ... } (minutes). */
export function parseTypical(raw: string | undefined): Map<string, number> {
  const out = new Map<string, number>();
  for (const part of (raw ?? "").split(/[,;\n]/)) {
    const m = part.trim().match(/^([^=:\s]+)\s*[=:]\s*(\d+(?:\.\d+)?)$/);
    if (!m) continue;
    const min = Number(m[2]);
    if (min > 0 && min < 600) out.set(m[1].toLowerCase(), min);
  }
  return out;
}

/** "5-11" -> [5, 11): live traffic is requested from 5:00 up to (not incl.) 11:00. */
export function parseLiveHours(raw: string | undefined): [number, number] {
  const m = (raw ?? "").trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 0 && b <= 24 && a < b) return [a, b];
  }
  return [5, 11];
}

function nyHour(nowMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(nowMs));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}

/** Whether live traffic is configured at all (address + key present). */
export function liveTrafficConfigured(): boolean {
  return !!homeAddress() && !!process.env.GOOGLE_MAPS_API_KEY;
}

/** Whether `nowMs` falls in the hours when live traffic is worth asking for. */
export function inLiveTrafficHours(nowMs: number = Date.now()): boolean {
  const [from, to] = parseLiveHours(process.env.DRIVE_LIVE_HOURS);
  const h = nyHour(nowMs);
  return h >= from && h < to;
}

// --- live traffic (Google Routes) ---------------------------------------------

/**
 * One Google Routes call. Returns seconds, or null on any failure — and null is
 * a result too: it is cached for the slot, so a dead key or an outage costs one
 * quick call per destination per 10 minutes rather than one per request.
 * `slot` only forms the cache key.
 */
async function googleDriveSeconds(
  key: string,
  destinationJson: string,
  slot: number
): Promise<number | null> {
  void slot;
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  const origin = homeAddress();
  if (!apiKey || !origin) return null;
  try {
    const res = await fetch(
      "https://routes.googleapis.com/directions/v2:computeRoutes",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": "routes.duration",
        },
        body: JSON.stringify({
          origin: { address: origin },
          destination: JSON.parse(destinationJson),
          travelMode: "DRIVE",
          routingPreference: "TRAFFIC_AWARE",
        }),
        // Don't let a slow routing call hang the whole board.
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        cache: "no-store",
      }
    );
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // Say why, so a dead key or exhausted quota is visible in the logs
      // instead of just "no drive time". (Never log the key or the address.)
      const err = json?.error;
      console.warn(
        `[drive] Google Routes failed for "${key}": http ${res.status} ` +
          `${err?.status ?? ""} ${err?.details?.[0]?.reason ?? ""}`.trimEnd()
      );
      return null;
    }
    const dur: string | undefined = json?.routes?.[0]?.duration; // e.g. "934s"
    const sec = dur ? parseInt(dur, 10) : NaN;
    if (!Number.isFinite(sec) || sec < 30 || sec > 3 * 3600) {
      console.warn(`[drive] Google Routes gave no usable duration for "${key}"`);
      return null;
    }
    return sec;
  } catch (e) {
    console.warn(
      `[drive] Google Routes failed for "${key}": ${e instanceof Error ? e.name : "error"}`
    );
    return null;
  }
}

// Shared across serverless instances, keyed by (destination, 10-minute slot).
const cachedGoogle = unstable_cache(googleDriveSeconds, ["drive-live-v1"], {
  revalidate: 3600,
});

// Per-instance memo in front of the shared cache (saves a cache round-trip on
// every request within a slot, and collapses concurrent lookups).
const memo = new Map<string, Promise<number | null>>();

function liveSeconds(key: string, destination: Destination): Promise<number | null> {
  const slot = Math.floor(Date.now() / SLOT_MS); // real time, never a `?now=` override
  const k = `${key}:${slot}`;
  let p = memo.get(k);
  if (!p) {
    p = cachedGoogle(key, JSON.stringify(destination), slot).catch(() => null);
    memo.set(k, p);
    for (const old of memo.keys()) {
      if (!old.endsWith(`:${slot}`)) memo.delete(old);
    }
  }
  return p;
}

// --- public API ---------------------------------------------------------------

async function estimate(
  key: string,
  destination: Destination,
  wantLive: boolean
): Promise<DriveEstimate | null> {
  if (wantLive && liveTrafficConfigured()) {
    const sec = await liveSeconds(key, destination);
    if (sec != null) return { sec, source: "live" };
  }
  const typicalMin = parseTypical(process.env.DRIVE_TYPICAL_MIN).get(key.toLowerCase());
  return typicalMin != null ? { sec: Math.round(typicalMin * 60), source: "typical" } : null;
}

/**
 * Drive time home -> a lat/lon point (e.g. a train station). `wantLive` asks
 * for live traffic if it's configured; otherwise (or on failure) the typical
 * time is returned. Null means no estimate at all is configured.
 */
export function driveTo(
  key: string,
  dest: LatLon | undefined,
  wantLive: boolean
): Promise<DriveEstimate | null> {
  if (!dest) return estimate(key, { address: "" }, false);
  return estimate(
    key,
    { location: { latLng: { latitude: dest.lat, longitude: dest.lon } } },
    wantLive
  );
}

/** Drive time home -> an address string (Google geocodes it). */
export function driveToAddress(
  key: string,
  address: string,
  wantLive: boolean
): Promise<DriveEstimate | null> {
  return estimate(key, { address }, wantLive);
}

/** Test hook: forget the per-instance memo. */
export function _resetForTests(): void {
  memo.clear();
}
