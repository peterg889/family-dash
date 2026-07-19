/**
 * NJ Transit real-time rail data (DepartureVision), layered onto the GTFS
 * board to add live delay, track, and status per train.
 *
 * Uses the raildata.njtransit.com REST API (the developer.njtransit.com
 * portal):
 *
 *   POST getToken               (username, password)  -> { Authenticated, UserToken }
 *   POST getTrainSchedule19Rec  (token, station, line) -> { STATION_2CHAR, ITEMS: [...] }
 *
 * getTrainSchedule19Rec returns the same DepartureVision data as
 * getTrainSchedule — the next ~19 real-time trains at one station — but without
 * each train's full stop list (which we don't use), so the payload is ~10x
 * smaller. It only covers the near term; there is no live data for tomorrow's
 * trains, so callers should skip the lookup then.
 *
 * Credentials come from the environment and never touch the repo:
 *
 *   NJT_API_USERNAME, NJT_API_PASSWORD   (required for any live data)
 *   NJT_API_BASE                         (optional; overrides the API base URL)
 *
 * Every function degrades to null / empty when credentials are missing or the
 * API fails — the board must keep working on the GTFS schedule alone.
 *
 * NJT caps usage (40,000 current-data calls/day), so boards are cached per
 * station and the auth token is reused until it stops working.
 */

const TZ = "America/New_York";

const BASE =
  process.env.NJT_API_BASE ?? "https://raildata.njtransit.com/api/TrainData";

/** GTFS stop_id -> NJT 2-character station code (Appendix V of the API docs). */
export const NJT_STATION_2CHAR: Record<string, string> = {
  "92": "MR", // Morristown
  "18": "BV", // Bernardsville
  "105": "NY", // New York Penn Station
  "63": "HB", // Hoboken
};

// A live train, as returned by getTrainSchedule for one station.
export type LiveTrain = {
  schedDepEpochMs: number | null; // scheduled departure at this station
  destination: string;
  track: string; // "" until a track is assigned
  line: string;
  trainId: string;
  status: string; // free text, e.g. "in 12 Min" / "ALL ABOARD" / "CANCELLED"
  secLate: number;
};

export type LiveState =
  | "on-time"
  | "delayed"
  | "cancelled"
  | "boarding"
  | "unknown";

// The live status attached to a scheduled departure once matched.
export type LiveStatus = {
  state: LiveState;
  delayMin: number; // 0 when on time
  statusText: string; // the raw STATUS text, for display
  track: string | null; // null when unassigned
  trainId: string | null;
};

// --- date parsing ------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Offset (ms) of the given instant in America/New_York relative to UTC. */
function tzOffsetMs(date: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    hour,
    Number(p.minute),
    Number(p.second)
  );
  return asUTC - date.getTime();
}

/** Epoch ms for a New York wall-clock time (two passes converge across DST). */
function nyWallToEpoch(
  y: number,
  mo0: number,
  d: number,
  h: number,
  mi: number,
  s: number
): number {
  const naive = Date.UTC(y, mo0, d, h, mi, s);
  let guess = naive - tzOffsetMs(new Date(naive));
  guess = naive - tzOffsetMs(new Date(guess));
  return guess;
}

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
  const mo0 = MONTHS[m[2].toLowerCase()];
  if (mo0 === undefined) return null;
  const d = Number(m[1]);
  const y = Number(m[3]);
  let h = Number(m[4]);
  const mi = Number(m[5]);
  const sec = Number(m[6]);
  const ap = m[7].toUpperCase();
  if (ap === "PM" && h !== 12) h += 12;
  if (ap === "AM" && h === 12) h = 0;
  return nyWallToEpoch(y, mo0, d, h, mi, sec);
}

// --- status classification ---------------------------------------------------

// NJT reports SEC_LATE as -60 (and other negatives) when there's no live
// estimate yet — the train is scheduled but not actively tracked. Treat any
// negative as "no delay known" rather than "early".
function delayMinutes(secLate: number): number {
  return secLate > 0 ? Math.round(secLate / 60) : 0;
}

/** Turn the raw STATUS text + SEC_LATE into a normalized LiveStatus. */
function classify(train: LiveTrain): LiveStatus {
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
  if (up.includes("CANCEL")) state = "cancelled";
  else if (up.includes("ABOARD") || up.includes("BOARD")) state = "boarding";
  else if (up.includes("SUSPEND")) state = "cancelled";
  else if (delayMin >= 1) state = "delayed";
  else state = "on-time";

  return { state, delayMin, statusText: text, track, trainId };
}

// --- token auth --------------------------------------------------------------

// A token is valid for a while; reuse it and only re-auth when a call fails.
const TOKEN_TTL_MS = 30 * 60_000;
let tokenCache: { token: string; at: number } | null = null;

async function postForm(
  path: string,
  fields: Record<string, string>
): Promise<unknown | null> {
  try {
    const res = await fetch(`${BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(4500),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch (and cache) an API token, or null when creds are missing / auth fails. */
async function getToken(now: number, forceRefresh = false): Promise<string | null> {
  const username = process.env.NJT_API_USERNAME;
  const password = process.env.NJT_API_PASSWORD;
  if (!username || !password) return null;

  if (!forceRefresh && tokenCache && now - tokenCache.at < TOKEN_TTL_MS) {
    return tokenCache.token;
  }

  const json = (await postForm("getToken", { username, password })) as
    | { Authenticated?: string; UserToken?: string }
    | null;
  const token = json?.UserToken;
  if (!token || json?.Authenticated === "False") {
    tokenCache = null;
    return null;
  }
  tokenCache = { token, at: now };
  return token;
}

// --- board fetch -------------------------------------------------------------

// DepartureVision refreshes on the order of ~30–60s; cache each station board
// so overlapping boards and quick client refreshes share one upstream call.
const BOARD_TTL_MS = 45_000;
const boardCache = new Map<string, { at: number; trains: LiveTrain[] }>();

type RawItem = {
  SCHED_DEP_DATE?: string;
  DESTINATION?: string;
  TRACK?: string;
  LINE?: string;
  TRAIN_ID?: string;
  STATUS?: string;
  SEC_LATE?: string | number;
};

type RawStation = {
  STATION_2CHAR?: string;
  ITEMS?: RawItem[] | { ITEM?: RawItem[] };
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
  // board is empty or a full-screen message is up — not an auth failure.
  if (json.STATION_2CHAR !== undefined) return [];
  return null; // shape we don't recognize -> treat as failure
}

function toLiveTrain(it: RawItem): LiveTrain {
  return {
    schedDepEpochMs: parseNjtDate(it.SCHED_DEP_DATE),
    destination: it.DESTINATION ?? "",
    track: it.TRACK ?? "",
    line: it.LINE ?? "",
    trainId: it.TRAIN_ID ?? "",
    status: it.STATUS ?? "",
    secLate: Number(it.SEC_LATE ?? 0) || 0,
  };
}

/** Fetch the live board for one NJT 2-char station code. */
async function fetchStationBoard(
  station2char: string,
  now: number
): Promise<LiveTrain[]> {
  const hit = boardCache.get(station2char);
  if (hit && now - hit.at < BOARD_TTL_MS) return hit.trains;

  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await getToken(now, attempt === 1);
    if (!token) return [];

    const json = (await postForm("getTrainSchedule19Rec", {
      token,
      station: station2char,
      line: "",
    })) as RawStation | null;

    const items = itemsOf(json);
    if (items === null) {
      // Likely an expired/invalid token — drop it and retry once with a fresh one.
      tokenCache = null;
      continue;
    }

    const trains = items.map(toLiveTrain);
    boardCache.set(station2char, { at: now, trains });
    return trains;
  }
  return [];
}

/**
 * Fetch live boards for the given GTFS origin stop_ids concurrently, keyed by
 * stop_id. Stations without a known 2-char code, or with no live data, map to
 * an empty array.
 */
export async function fetchLiveBoards(
  gtfsOriginIds: string[],
  now: number = Date.now()
): Promise<Map<string, LiveTrain[]>> {
  const out = new Map<string, LiveTrain[]>();
  const ids = [...new Set(gtfsOriginIds)];
  await Promise.all(
    ids.map(async (id) => {
      const code = NJT_STATION_2CHAR[id];
      out.set(id, code ? await fetchStationBoard(code, now) : []);
    })
  );
  return out;
}

// Time-match window: NJT's SCHED_DEP_DATE should agree with GTFS to within a
// minute, but allow slack for rounding / minor feed drift.
const MATCH_WINDOW_MS = 90_000;

// A train-number match is trusted only if it's also in the same neighborhood in
// time, so a number reused on a later service day can't hijack today's board.
const TRAIN_ID_WINDOW_MS = 3 * 3600_000;

/** Normalize a train number for comparison (strip leading zeros; upper-case). */
function normId(id: string | null | undefined): string {
  return String(id ?? "").trim().replace(/^0+/, "").toUpperCase();
}

/**
 * Find the live status for a scheduled departure. Matches on train number
 * first (GTFS block_id == live TRAIN_ID) — exact and unambiguous even where
 * many lines share a station — and falls back to the closest scheduled time
 * within a minute. Returns null when there's no live train for it (e.g. beyond
 * the ~19-train real-time window).
 */
export function matchLiveStatus(
  trains: LiveTrain[] | undefined,
  schedDepEpochMs: number,
  trainNumber?: string
): LiveStatus | null {
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
    if (best && bestDiff <= TRAIN_ID_WINDOW_MS) return classify(best);
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
  return classify(best);
}
