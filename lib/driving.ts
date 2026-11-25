/**
 * Drive time from home to a destination — measured by Google, never guessed.
 *
 * Every figure here is a real traffic-aware measurement from the Google Routes
 * API. To keep the number of Google calls small and predictable:
 *
 *   - During the LIVE HOURS (default 6–8 AM New York, when someone is about to
 *     leave) each destination is re-measured about every 5 minutes.
 *   - Outside those hours nothing is measured; the board keeps showing the most
 *     recent measurement — in practice the last one from that morning — and
 *     marks it as earlier ("~16 min"). The one exception: if there is no
 *     measurement from the last day or so (first deploy, or the morning was
 *     missed), one is taken so the board isn't left without a drive time.
 *   - If Google can't be reached, the last measurement keeps being shown,
 *     marked as earlier. If there has never been one, there is no drive time
 *     and the screens say so.
 *
 * Cost bound: 2 hours x 12 five-minute slots x 3 destinations = 72 Google calls
 * a day, however many screens are polling.
 *
 * Measurements are kept in Vercel's Runtime Cache, shared by every server
 * instance, so instances neither repeat each other's calls nor lose the last
 * measurement on a cold start.
 *
 * Environment (set in Vercel, never in the repo):
 *   HOME_ADDRESS         where drives start — only ever sent to Google
 *   GOOGLE_MAPS_API_KEY  a Google Cloud API key with the Routes API enabled
 *   DRIVE_LIVE_HOURS     New York hours to measure in, default "6-8"
 */

import { getCache } from "@vercel/functions";

export type DriveEstimate = {
  sec: number;
  /** "live": measured within the last few minutes. "earlier": the most recent measurement we have. */
  source: "live" | "earlier";
  measuredAt: number; // epoch ms of the Google measurement
};

type Measurement = { sec: number; at: number };

type LatLon = { lat: number; lon: number };

/** A Google Routes "waypoint" destination — a coordinate or an address. */
type Destination =
  | { location: { latLng: { latitude: number; longitude: number } } }
  | { address: string };

// In the live hours: at most one measurement per destination per 5 minutes.
const SLOT_MS = 5 * 60_000;
// Outside them: only when the last measurement is over a day old, and then at
// most this often. (With no measurement at all — a new key, a first deploy —
// the 5-minute slot is used, so the board isn't left without a drive time.)
const OFF_HOURS_SLOT_MS = 30 * 60_000;
// "Recent" outside the live hours: this morning's measurements stay good until
// tomorrow's live hours begin (at most ~22 h later).
const OFF_HOURS_MAX_AGE_MS = 26 * 3600_000;
// Shown as "live" on the screens up to this age.
const LIVE_MAX_AGE_MS = SLOT_MS + 2 * 60_000;
// How long the last good measurement is remembered if Google stops answering.
const KEEP_S = 7 * 24 * 3600;

const CALL_TIMEOUT_MS = 2500;

// --- configuration (read at call time so tests and env changes take effect) ---

function homeAddress(): string | null {
  return process.env.HOME_ADDRESS?.trim() || null;
}

/** "6-8" -> [6, 8): measurements are taken from 6:00 up to (not incl.) 8:00. */
export function parseLiveHours(raw: string | undefined): [number, number] {
  const m = (raw ?? "").trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a >= 0 && b <= 24 && a < b) return [a, b];
  }
  return [6, 8];
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

/** Whether Google traffic is configured at all (address + key present). */
export function liveTrafficConfigured(): boolean {
  return !!homeAddress() && !!process.env.GOOGLE_MAPS_API_KEY;
}

/** Whether `nowMs` falls in the hours when drive times are re-measured. */
export function inLiveTrafficHours(nowMs: number = Date.now()): boolean {
  const [from, to] = parseLiveHours(process.env.DRIVE_LIVE_HOURS);
  const h = nyHour(nowMs);
  return h >= from && h < to;
}

// --- shared cache --------------------------------------------------------------
// A cache hiccup must never break the board, so every access is guarded: a
// failed read is a miss, a failed write is ignored.

const cache = () => getCache({ namespace: "drive" });

async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    return ((await cache().get(key)) as T | null | undefined) ?? null;
  } catch {
    return null;
  }
}

async function cacheSet(key: string, value: unknown, ttlSeconds: number): Promise<void> {
  try {
    await cache().set(key, value, { ttl: ttlSeconds, name: key });
  } catch {
    // ignore
  }
}

async function readLast(key: string): Promise<Measurement | null> {
  const m = await cacheGet<Measurement>(`last:${key}`);
  return m && typeof m.sec === "number" && typeof m.at === "number" ? m : null;
}

// --- Google Routes ---------------------------------------------------------------

/** One Google Routes call. Returns seconds, or null on any failure (reason logged). */
async function googleDriveSeconds(
  key: string,
  destination: Destination
): Promise<number | null> {
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
          destination,
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

// Per-instance record of the attempt made in each slot: collapses concurrent
// requests into one call and stops this instance asking twice in a slot even if
// the shared cache is unavailable.
const attempts = new Map<string, Promise<Measurement | null>>();

/**
 * Take one measurement for this slot — unless this or another instance already
 * tried in it, in which case return whatever that attempt left behind.
 */
function measureOnce(
  key: string,
  destination: Destination,
  slotMs: number
): Promise<Measurement | null> {
  const now = Date.now(); // real time, never a `?now=` override
  const slotKey = `tried:${key}:${slotMs}:${Math.floor(now / slotMs)}`;
  let p = attempts.get(slotKey);
  if (!p) {
    p = (async () => {
      if (await cacheGet(slotKey)) return readLast(key); // another instance has this slot
      await cacheSet(slotKey, 1, Math.ceil(slotMs / 1000));
      const sec = await googleDriveSeconds(key, destination);
      if (sec == null) return null;
      const m: Measurement = { sec, at: now };
      await cacheSet(`last:${key}`, m, KEEP_S);
      return m;
    })();
    attempts.set(slotKey, p);
    for (const old of attempts.keys()) {
      if (old.startsWith(`tried:${key}:`) && old !== slotKey) attempts.delete(old);
    }
  }
  return p;
}

// --- public API -----------------------------------------------------------------

const toEstimate = (m: Measurement, now: number): DriveEstimate => ({
  sec: m.sec,
  source: now - m.at <= LIVE_MAX_AGE_MS ? "live" : "earlier",
  measuredAt: m.at,
});

async function estimate(
  key: string,
  destination: Destination,
  allowGoogle: boolean
): Promise<DriveEstimate | null> {
  const now = Date.now();
  const last = await readLast(key);
  const live = inLiveTrafficHours(now);
  const freshEnough =
    !!last && now - last.at < (live ? SLOT_MS : OFF_HOURS_MAX_AGE_MS);

  if (!freshEnough && allowGoogle && liveTrafficConfigured()) {
    const m = await measureOnce(
      key,
      destination,
      live || !last ? SLOT_MS : OFF_HOURS_SLOT_MS
    );
    if (m) return toEstimate(m, now);
  }
  // No new measurement: keep showing the last real one, however old, marked as such.
  return last ? toEstimate(last, now) : null;
}

/**
 * Drive time home -> a lat/lon point (e.g. a train station). `allowGoogle`
 * false (a test clock) never calls Google but may still return the last
 * measurement. Null means Google has never given us a figure.
 */
export function driveTo(
  key: string,
  dest: LatLon | undefined,
  allowGoogle: boolean
): Promise<DriveEstimate | null> {
  if (!dest) return Promise.resolve(null);
  return estimate(
    key,
    { location: { latLng: { latitude: dest.lat, longitude: dest.lon } } },
    allowGoogle
  );
}

/** Drive time home -> an address string (Google geocodes it). */
export function driveToAddress(
  key: string,
  address: string,
  allowGoogle: boolean
): Promise<DriveEstimate | null> {
  return estimate(key, { address }, allowGoogle);
}

/** Test hook: forget this instance's in-memory state (the shared cache is untouched). */
export function _resetForTests(): void {
  attempts.clear();
}
