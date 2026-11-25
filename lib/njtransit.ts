/**
 * NJ Transit real-time rail data (DepartureVision).
 *
 * Uses the raildata.njtransit.com REST API (the developer.njtransit.com
 * portal):
 *
 *   POST getToken               (username, password)  -> { Authenticated, UserToken }
 *   POST getTrainSchedule       (token, station)      -> { STATION_2CHAR, ITEMS: [...] }  with each train's STOPS
 *   POST getTrainSchedule19Rec  (token, station, line) -> same, without STOPS (~10x smaller)
 *
 * Both board calls return the next ~19 trains NJ Transit is actually running
 * at one station, with delay / track / status. The full variant also carries
 * every train's stop list, which is what lets lib/board.ts build a whole board
 * (departure *and* arrival times, both directions) from the live feed instead
 * of the static timetable — so adjusted schedules show up without a rebuild.
 *
 * Credentials come from the environment and never touch the repo:
 *
 *   NJT_API_USERNAME, NJT_API_PASSWORD   (required for any live data)
 *   NJT_API_BASE                         (optional; overrides the API base URL)
 *
 * Every function degrades to null / empty when credentials are missing or the
 * API fails — the board must keep working on the timetable alone.
 *
 * Limits that shape this file: board calls are capped at 40,000/day (generous),
 * but getToken is capped at about FIVE per day. So one token is shared by every
 * server instance and every deployment, reused until the API rejects it, and —
 * critically — a timeout or a 5xx is never mistaken for "the token is bad".
 */

import { getCache } from "@vercel/functions";
import { nyWallToEpoch } from "./departures";

const BASE =
  process.env.NJT_API_BASE ?? "https://raildata.njtransit.com/api/TrainData";

/** GTFS stop_id -> NJT 2-character station code (Appendix V of the API docs). */
export const NJT_STATION_2CHAR: Record<string, string> = {
  "92": "MR", // Morristown
  "18": "BV", // Bernardsville
  "105": "NY", // New York Penn Station
  "63": "HB", // Hoboken
};

/** One stop on a live train's itinerary (full board variant only). */
export type LiveStop = {
  code: string; // NJT 2-char station code
  schedEpochMs: number | null; // scheduled time at this stop (DEP_TIME)
  estEpochMs: number | null; // estimated / actual time at this stop (TIME)
  departed: boolean;
  dischargeOnly: boolean; // passengers may only get off here
};

// A live train, as returned for one station.
export type LiveTrain = {
  schedDepEpochMs: number | null; // scheduled departure at this station
  destination: string;
  track: string; // "" until a track is assigned
  line: string;
  trainId: string;
  status: string; // free text, e.g. "in 12 Min" / "ALL ABOARD" / "CANCELLED"
  secLate: number;
  color: string; // line colour, hex without '#', "" when absent
  stops: LiveStop[] | null; // null on the light variant
};

export type LiveState =
  | "on-time"
  | "delayed"
  | "cancelled"
  | "boarding"
  | "unknown";

// The live status attached to a departure.
export type LiveStatus = {
  state: LiveState;
  delayMin: number; // 0 when on time, or when delayed by an unknown amount
  statusText: string; // the raw STATUS text, for display
  track: string | null; // null when unassigned
  trainId: string | null;
};

// --- date parsing ------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse an NJT timestamp like "29-Jun-2016 11:01:00 AM" (New York local time)
 * to epoch ms. Returns null on an unexpected shape or an empty value.
 */
export function parseNjtDate(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s
    .trim()
    .match(
      /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*([AP]M)$/i
    );
  if (!m) return null;
  const mo = MONTHS[m[2].toLowerCase()];
  if (mo === undefined) return null;
  const d = Number(m[1]);
  const y = Number(m[3]);
  let h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  const ap = m[7].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return nyWallToEpoch(y, mo, d, h, mi, sec);
}

// --- status classification ---------------------------------------------------

// NJT reports SEC_LATE as -60 (and other negatives) when there's no live
// estimate yet — the train is scheduled but not actively tracked. Treat any
// negative as "no delay known" rather than "early".
function delayMinutes(secLate: number): number {
  return secLate > 0 ? Math.round(secLate / 60) : 0;
}

/** Turn the raw STATUS text + SEC_LATE into a normalized LiveStatus. */
export function classify(train: LiveTrain): LiveStatus {
  const text = (train.status || "").trim();
  const up = text.toUpperCase();
  const delayMin = delayMinutes(train.secLate);
  // A single-track branch (e.g. Gladstone) reports TRACK "Single" — not a
  // platform a rider picks, so don't surface it as a track number.
  const rawTrack = (train.track || "").trim();
  const track =
    rawTrack && rawTrack.toLowerCase() !== "single" ? rawTrack : null;
  const trainId = train.trainId ? train.trainId : null;

  let state: LiveState;
  if (up.includes("CANCEL") || up.includes("SUSPEND")) state = "cancelled";
  else if (up.includes("ABOARD") || up.includes("BOARD")) state = "boarding";
  // "DELAYED" with no estimate still means delayed — delayMin stays 0 and the
  // screens say "delayed" without a number.
  else if (delayMin >= 1 || up.includes("DELAY") || up.includes("LATE"))
    state = "delayed";
  else state = "on-time";

  return { state, delayMin, statusText: text, track, trainId };
}

// --- HTTP --------------------------------------------------------------------

// The route answers within a few seconds even when NJ Transit doesn't: the
// E-Ink device gives up on a fetch after 8 s, and a board without live status
// beats no board.
const CALL_TIMEOUT_MS = 2500;

type ApiResult =
  | { kind: "ok"; json: unknown }
  | { kind: "auth" } // the API explicitly rejected our token
  | { kind: "fail"; why: string }; // timeout, network, 5xx, garbage — NOT a token problem

async function postForm(
  path: string,
  fields: Record<string, string>
): Promise<ApiResult> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      cache: "no-store",
    });
    text = await res.text();
  } catch (e) {
    return { kind: "fail", why: e instanceof Error ? e.name : "network" };
  }
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // fall through with json === null
  }
  // A rejected token comes back as HTTP 500 {"errorMessage":"Invalid token."}.
  const msg = (json as { errorMessage?: unknown } | null)?.errorMessage;
  if (typeof msg === "string" && /token/i.test(msg)) return { kind: "auth" };
  if (!res.ok) return { kind: "fail", why: `http ${res.status}` };
  if (json === null) return { kind: "fail", why: "empty response" };
  return { kind: "ok", json };
}

// --- token auth --------------------------------------------------------------
//
// getToken is capped at ~5 calls/day, so the budget is designed in rather than
// hoped for. The token lives in Vercel's Runtime Cache — shared by every server
// instance and, unlike Next's Data Cache, kept across deployments — and is
// reused until the API explicitly rejects it. Logins are counted per day in the
// same cache and stop at MAX_TOKENS_PER_DAY; a normal day needs none.

const MAX_TOKENS_PER_DAY = 3;
const MINT_BACKOFF_MS = 15 * 60_000; // after a failed login, don't retry on this instance for a while
const TOKEN_KEEP_S = 30 * 24 * 3600; // reuse a token until it is rejected
const store = () => getCache({ namespace: "njt" });

/** Budget "day": rolls over at 3 AM New York, when almost nothing is running. */
function tokenDay(nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(nowMs - 3 * 3600_000));
}

/**
 * Off Vercel (local dev, tests) @vercel/functions quietly uses a per-process
 * in-memory cache, which is fine there. But if that ever happened on a deployed
 * instance, every cold start would think it had no token and log in — exactly
 * what the budget can't afford. So on Vercel, insist on the real shared cache.
 */
function sharedCacheAvailable(): boolean {
  const env = process.env.VERCEL_ENV;
  if (env !== "production" && env !== "preview") return true;
  const ctx = (globalThis as Record<symbol, { get?: () => { cache?: unknown } } | undefined>)[
    Symbol.for("@vercel/request-context")
  ]?.get?.();
  return (
    !!ctx?.cache ||
    (!!process.env.RUNTIME_CACHE_ENDPOINT && !!process.env.RUNTIME_CACHE_HEADERS)
  );
}

// Reads tell "nothing stored" apart from "the cache itself failed": without the
// cache we can't know what other instances have done, and must not log in.
type Read<T> = { ok: true; value: T | null } | { ok: false };

async function storeGet<T>(key: string): Promise<Read<T>> {
  if (!sharedCacheAvailable()) return { ok: false };
  try {
    return { ok: true, value: ((await store().get(key)) as T | null | undefined) ?? null };
  } catch {
    return { ok: false };
  }
}

async function storeSet(key: string, value: unknown, ttlSeconds: number): Promise<boolean> {
  if (!sharedCacheAvailable()) return false;
  try {
    await store().set(key, value, { ttl: ttlSeconds, name: `njt:${key}` });
    return true;
  } catch {
    return false;
  }
}

// Mint a brand-new token. Throws on missing creds / failed auth.
async function mintToken(): Promise<string> {
  const username = process.env.NJT_API_USERNAME;
  const password = process.env.NJT_API_PASSWORD;
  if (!username || !password) throw new Error("njt: missing credentials");

  const res = await postForm("getToken", { username, password });
  const json = res.kind === "ok" ? (res.json as { Authenticated?: string; UserToken?: string }) : null;
  const token = json?.UserToken;
  if (!token || json?.Authenticated === "False") {
    throw new Error(
      `njt: login failed (${res.kind === "fail" ? res.why : res.kind === "auth" ? "rejected" : "not authenticated"})`
    );
  }
  return token;
}

let tokenMemo: string | null = null; // this instance's current token
const rejectedTokens = new Set<string>(); // tokens the API has refused
let mintBackoffUntil = 0;
let tokenInFlight: Promise<string | null> | null = null;

export function hasCredentials(): boolean {
  return !!(process.env.NJT_API_USERNAME && process.env.NJT_API_PASSWORD);
}

async function findOrMintToken(): Promise<string | null> {
  const stored = await storeGet<{ token: string }>("token");
  if (!stored.ok) {
    console.warn("[njt] token cache unavailable — not logging in");
    return null;
  }
  const have = stored.value?.token;
  if (have && !rejectedTokens.has(have)) return have;

  // No usable token anywhere: log in, if today's budget allows.
  if (Date.now() < mintBackoffUntil) return null;
  const day = tokenDay(Date.now());
  const used = await storeGet<number>(`logins:${day}`);
  if (!used.ok) return null;
  const count = used.value ?? 0;
  if (count >= MAX_TOKENS_PER_DAY) {
    console.warn(`[njt] daily login budget spent (${count}) — live status off until tomorrow`);
    mintBackoffUntil = Date.now() + MINT_BACKOFF_MS;
    return null;
  }
  // Count the attempt before making it, so a failing login can't be repeated
  // by every instance.
  if (!(await storeSet(`logins:${day}`, count + 1, 48 * 3600))) return null;
  try {
    const token = await mintToken();
    await storeSet("token", { token, mintedAt: Date.now() }, TOKEN_KEEP_S);
    console.info(`[njt] logged in (login ${count + 1} of ${MAX_TOKENS_PER_DAY} allowed for ${day})`);
    return token;
  } catch (e) {
    mintBackoffUntil = Date.now() + MINT_BACKOFF_MS;
    console.warn(`[njt] ${e instanceof Error ? e.message : "login failed"}`);
    return null;
  }
}

/** The token to use right now, or null (no creds / login failing / day's budget spent). */
async function getToken(): Promise<string | null> {
  if (!hasCredentials()) return null;
  if (tokenMemo) return tokenMemo;
  // Collapse concurrent lookups (the station boards refresh in parallel) into
  // one cache read — and so at most one login.
  if (!tokenInFlight) {
    tokenInFlight = findOrMintToken().finally(() => {
      tokenInFlight = null;
    });
  }
  const token = await tokenInFlight;
  if (token) tokenMemo = token;
  return token;
}

/** The API explicitly rejected `token`: stop using it, here and on other instances. */
async function tokenRejected(token: string): Promise<void> {
  if (rejectedTokens.has(token)) return;
  rejectedTokens.add(token);
  if (tokenMemo === token) tokenMemo = null;
  console.warn("[njt] token was rejected by the API");
  try {
    const stored = await storeGet<{ token: string }>("token");
    if (stored.ok && stored.value?.token === token) await store().delete("token");
  } catch {
    // ignore — the rejected set keeps this instance off it regardless
  }
}

// --- board fetch -------------------------------------------------------------

// DepartureVision refreshes on the order of ~30–60s; cache each station board
// so overlapping boards and quick client refreshes share one upstream call.
const BOARD_TTL_MS = 45_000;
// After a failed fetch, don't ask again for a minute — and meanwhile a board
// that is only slightly old is still better than none.
const FAIL_RETRY_MS = 60_000;
const STALE_OK_MS = 2 * 60_000;

type BoardEntry = {
  at: number;
  trains: LiveTrain[];
  messages: string[]; // NJ Transit's station messages (service alerts), plain text
  failedAt: number;
};
const boardCache = new Map<string, BoardEntry>();
// The same boards, shared by every server instance through the Runtime Cache:
// however many instances are running, a station is fetched about once per
// BOARD_TTL_MS in total — a hard ceiling of roughly 1,900 calls a day per board.
type SharedBoard = { at: number; trains: LiveTrain[]; messages: string[] };

type RawStop = {
  STATION_2CHAR?: string;
  TIME?: string;
  DEP_TIME?: string;
  DEPARTED?: string;
  PICKUP?: string;
  DROPOFF?: string;
};

type RawItem = {
  SCHED_DEP_DATE?: string;
  DESTINATION?: string;
  TRACK?: string;
  LINE?: string;
  TRAIN_ID?: string;
  STATUS?: string;
  SEC_LATE?: string | number;
  BACKCOLOR?: string;
  STOPS?: RawStop[] | { STOP?: RawStop[] } | null;
};

type RawStation = {
  STATION_2CHAR?: string;
  STATIONMSGS?: unknown;
  ITEMS?: RawItem[] | { ITEM?: RawItem[] } | null;
};

function itemsOf(json: RawStation | null): RawItem[] | null {
  if (!json) return null;
  const items = json.ITEMS;
  if (Array.isArray(items)) return items;
  // Some encodings nest as { ITEM: [...] }; a lone item can be an object.
  if (items && Array.isArray((items as { ITEM?: RawItem[] }).ITEM)) {
    return (items as { ITEM: RawItem[] }).ITEM;
  }
  // A valid station response (STATION_2CHAR present) with no ITEMS means the
  // board is empty or a full-screen message is up — not a failure.
  if (json.STATION_2CHAR !== undefined) return [];
  return null; // shape we don't recognize -> treat as failure
}

function stopsOf(it: RawItem): LiveStop[] | null {
  const raw = Array.isArray(it.STOPS)
    ? it.STOPS
    : it.STOPS && Array.isArray((it.STOPS as { STOP?: RawStop[] }).STOP)
      ? (it.STOPS as { STOP: RawStop[] }).STOP
      : null;
  if (!raw || raw.length === 0) return null;
  return raw.map((s) => ({
    code: (s.STATION_2CHAR ?? "").trim().toUpperCase(),
    schedEpochMs: parseNjtDate(s.DEP_TIME) ?? parseNjtDate(s.TIME),
    estEpochMs: parseNjtDate(s.TIME),
    departed: (s.DEPARTED ?? "").trim().toUpperCase() === "YES",
    dischargeOnly: /discharge/i.test(`${s.PICKUP ?? ""} ${s.DROPOFF ?? ""}`),
  }));
}

/** Exported for tests: one raw API item -> LiveTrain. */
export function toLiveTrain(it: RawItem): LiveTrain {
  return {
    schedDepEpochMs: parseNjtDate(it.SCHED_DEP_DATE),
    destination: (it.DESTINATION ?? "").trim(),
    track: it.TRACK ?? "",
    line: it.LINE ?? "",
    trainId: (it.TRAIN_ID ?? "").trim(),
    status: it.STATUS ?? "",
    secLate: Number(it.SEC_LATE ?? 0) || 0,
    color: (it.BACKCOLOR ?? "").replace(/^#/, "").trim(),
    stops: stopsOf(it),
  };
}

/** Exported for tests: a raw station response -> LiveTrain[] (null = unrecognized). */
export function parseStationBoard(json: unknown): LiveTrain[] | null {
  const items = itemsOf(json as RawStation | null);
  return items === null ? null : items.map(toLiveTrain);
}

const MAX_ALERTS = 3;
const MAX_ALERT_CHARS = 240;

/**
 * NJ Transit's messages for a station (service alerts such as "trains are
 * subject to 20-minute delays"), as plain text. They ride along in the same
 * response as the board, so they cost no extra calls. Exported for tests.
 */
export function parseStationMessages(json: unknown): string[] {
  const raw = (json as RawStation | null)?.STATIONMSGS;
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : raw && Array.isArray((raw as { STATIONMSG?: unknown[] }).STATIONMSG)
      ? (raw as { STATIONMSG: unknown[] }).STATIONMSG
      : [];
  const out: string[] = [];
  for (const m of list) {
    const text =
      typeof m === "string"
        ? m
        : m && typeof m === "object"
          ? String(
              (m as Record<string, unknown>).MSG_TEXT ??
                (m as Record<string, unknown>).MSG_HTML ??
                (m as Record<string, unknown>).MESSAGE ??
                ""
            )
          : "";
    const clean = text
      .replace(/<[^>]*>/g, " ") // markup
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&#39;|&apos;/gi, "'")
      .replace(/&quot;/gi, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!clean || out.includes(clean)) continue;
    out.push(
      clean.length > MAX_ALERT_CHARS ? `${clean.slice(0, MAX_ALERT_CHARS - 1).trimEnd()}…` : clean
    );
    if (out.length >= MAX_ALERTS) break;
  }
  return out;
}

/**
 * Does this alert say trains are affected (delays, cancellations, suspended
 * service)? Those are worth a line on the sign; a general notice — a weather
 * advisory, cross-honoring, an elevator — is not.
 */
export function alertAffectsTrains(text: string): boolean {
  return /\b(delay\w*|cancel\w*|suspend\w*|suspension|no (train |rail )?service|not (running|operating)|subject to|running late|disabled train)\b/i.test(
    text
  );
}

export type BoardVariant = "full" | "light";

/**
 * Fetch the live board for one NJT 2-char station code. `full` includes each
 * train's stop list. Returns null when live data is unavailable (no creds, API
 * down, login budget spent) — distinct from [] which means "up, but empty".
 */
export async function fetchStationBoard(
  station2char: string,
  variant: BoardVariant = "light"
): Promise<LiveTrain[] | null> {
  const key = `${variant}:${station2char}`;
  const nowMs = Date.now(); // real time, never a `?now=` override
  const hit = boardCache.get(key);
  if (hit && hit.trains && nowMs - hit.at < BOARD_TTL_MS) return hit.trains;

  const staleOrNull = () =>
    hit && nowMs - hit.at < STALE_OK_MS ? hit.trains : null;
  if (hit && nowMs - hit.failedAt < FAIL_RETRY_MS) return staleOrNull();

  const fail = (why: string) => {
    console.warn(`[njt] ${station2char} board unavailable: ${why}`);
    boardCache.set(key, {
      at: hit?.at ?? 0,
      trains: hit?.trains ?? [],
      messages: hit?.messages ?? [],
      failedAt: nowMs,
    });
    return staleOrNull();
  };

  // Another instance may have fetched this board moments ago.
  const shared = await storeGet<SharedBoard>(`board:${key}`);
  if (shared.ok && shared.value && nowMs - shared.value.at < BOARD_TTL_MS) {
    boardCache.set(key, { ...shared.value, failedAt: 0 });
    return shared.value.trains;
  }

  for (let i = 0; i < MAX_TOKENS_PER_DAY; i++) {
    const tok = await getToken();
    if (!tok) return fail(hasCredentials() ? "no usable token" : "no credentials");

    const res = await postForm(
      variant === "full" ? "getTrainSchedule" : "getTrainSchedule19Rec",
      variant === "full"
        ? { token: tok, station: station2char }
        : { token: tok, station: station2char, line: "" }
    );
    if (res.kind === "auth") {
      await tokenRejected(tok);
      continue; // try a fresh token, if the day's budget allows
    }
    if (res.kind === "fail") return fail(res.why);

    const trains = parseStationBoard(res.json);
    if (trains === null) return fail("unrecognized response");
    const messages = parseStationMessages(res.json);
    boardCache.set(key, { at: nowMs, trains, messages, failedAt: 0 });
    await storeSet(`board:${key}`, { at: nowMs, trains, messages } satisfies SharedBoard, 90);
    return trains;
  }
  return fail("token rejected");
}

/**
 * Fetch several station boards concurrently, keyed by 2-char code. A station
 * maps to null when its live data is unavailable.
 */
export async function fetchStationBoards(
  requests: { code: string; variant: BoardVariant }[]
): Promise<Map<string, LiveTrain[] | null>> {
  const out = new Map<string, LiveTrain[] | null>();
  await Promise.all(
    requests.map(async ({ code, variant }) => {
      out.set(code, await fetchStationBoard(code, variant));
    })
  );
  return out;
}

/**
 * Station messages (service alerts) from the boards most recently fetched for
 * these station codes, de-duplicated. Reads what fetchStationBoard already has;
 * makes no calls.
 */
export function stationAlerts(codes: string[]): string[] {
  const out: string[] = [];
  const nowMs = Date.now();
  for (const code of codes) {
    for (const variant of ["full", "light"] as const) {
      const e = boardCache.get(`${variant}:${code}`);
      if (!e || nowMs - e.at > STALE_OK_MS) continue;
      for (const m of e.messages) if (!out.includes(m)) out.push(m);
    }
  }
  return out.slice(0, MAX_ALERTS);
}

// Time-match window: NJT's SCHED_DEP_DATE should agree with GTFS to within a
// minute, but allow slack for rounding / minor feed drift.
const MATCH_WINDOW_MS = 90_000;

// A train-number match is trusted only if it's also in the same neighborhood in
// time, so a number reused on a later service day can't hijack today's board.
const TRAIN_ID_WINDOW_MS = 3 * 3600_000;

/** Normalize a train number for comparison (strip leading zeros; upper-case). */
export function normId(id: string | null | undefined): string {
  return String(id ?? "").trim().replace(/^0+/, "").toUpperCase();
}

/** The live train with this number near this scheduled time, if any. */
export function findLiveTrain(
  trains: LiveTrain[] | null | undefined,
  schedDepEpochMs: number,
  trainNumber?: string
): LiveTrain | null {
  if (!trains || trains.length === 0) return null;

  // 1) Train-number match.
  const want = normId(trainNumber);
  if (want) {
    let best: LiveTrain | null = null;
    let bestDiff = Infinity;
    for (const t of trains) {
      if (normId(t.trainId) !== want) continue;
      const diff =
        t.schedDepEpochMs == null
          ? 0
          : Math.abs(t.schedDepEpochMs - schedDepEpochMs);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = t;
      }
    }
    if (best && bestDiff <= TRAIN_ID_WINDOW_MS) return best;
  }

  // 2) Scheduled-time fallback.
  let best: LiveTrain | null = null;
  let bestDiff = Infinity;
  for (const t of trains) {
    if (t.schedDepEpochMs == null) continue;
    const diff = Math.abs(t.schedDepEpochMs - schedDepEpochMs);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = t;
    }
  }
  if (!best || bestDiff > MATCH_WINDOW_MS) return null;
  return best;
}

/**
 * Find the live status for a scheduled departure. Matches on train number
 * first (GTFS block_id == live TRAIN_ID) — exact and unambiguous even where
 * many lines share a station — and falls back to the closest scheduled time
 * within a minute. Returns null when there's no live train for it (e.g. beyond
 * the ~19-train real-time window).
 */
export function matchLiveStatus(
  trains: LiveTrain[] | null | undefined,
  schedDepEpochMs: number,
  trainNumber?: string
): LiveStatus | null {
  const t = findLiveTrain(trains, schedDepEpochMs, trainNumber);
  return t ? classify(t) : null;
}

/** Test hook: forget all in-memory state (tokens, boards, back-offs). */
export function _resetForTests(): void {
  tokenMemo = null;
  rejectedTokens.clear();
  mintBackoffUntil = 0;
  tokenInFlight = null;
  boardCache.clear();
}
