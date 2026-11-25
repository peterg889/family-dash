import { NextResponse } from "next/server";
import {
  STATION_NAMES,
  STATION_COORDS,
  SCHEDULE_GENERATED_AT,
  scheduleStatus,
  type DayFilter,
} from "@/lib/departures";
import { driveTo, driveToAddress, type DriveEstimate } from "@/lib/driving";
import {
  fetchStationBoards,
  hasCredentials,
  stationAlerts,
  NJT_STATION_2CHAR,
  type BoardVariant,
  type LiveTrain,
} from "@/lib/njtransit";
import { buildBoard } from "@/lib/board";
import { deviceId, lastSeen, recordHeartbeat } from "@/lib/heartbeat";

export const dynamic = "force-dynamic";

// Daily school run — drive time + ETA from home, with a Maps directions link.
const commute = {
  name: "School",
  address: "9 Example School Rd, Exampleville, NJ 00000",
};

type BoardDef = { origin: string; dest: string; short: string };

// Outbound (home -> city): the morning commute. "Penn" is NY Penn (105),
// "Hoboken" is 63.
const OUTBOUND: BoardDef[] = [
  { origin: "92", dest: "105", short: "Penn" }, // Morristown -> New York
  { origin: "18", dest: "105", short: "Penn" }, // Bernardsville -> New York
  { origin: "18", dest: "63", short: "Hoboken" }, // Bernardsville -> Hoboken
];

// Inbound (city -> home): the evening trip home. destShort is the suburb.
const INBOUND: BoardDef[] = [
  { origin: "105", dest: "92", short: "Morristown" }, // NY -> Morristown
  { origin: "105", dest: "18", short: "Bernardsville" }, // NY -> Bernardsville
  { origin: "63", dest: "18", short: "Bernardsville" }, // Hoboken -> Bernardsville
];

// The stations we live near; their live boards cover both directions.
const HOME_STATIONS = new Set(["92", "18"]);

const TRAINS_PER_BOARD = 5; // default; `?limit=` may ask for up to MAX_TRAINS_PER_BOARD
const MAX_TRAINS_PER_BOARD = 16;

// The E-Ink sign identifies itself with `?device=eink`; its last check-in is
// reported in `status.device` for the health check.
const SIGN_ID = "eink";

// Leave home this many ms before (departure − drive time), as a safety margin.
const BUFFER_MS = 5 * 60_000;

// Window boundaries (NY hour): outbound today until 3 PM, inbound until 8 PM,
// then outbound for tomorrow morning.
const EVENING_FROM = 15; // 3 PM
const NEXT_MORNING_FROM = 20; // 8 PM
// When previewing tomorrow morning, skip trains before this time (minutes
// after midnight).
const MORNING_START_MIN = 6 * 60 + 30; // 6:30 AM

// The whole response must come back well inside the E-Ink device's 8 s fetch
// timeout even when NJ Transit is hanging; past this we answer without live data.
const LIVE_DEADLINE_MS = 3500;

function nyHour(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}

type Mode = "morning" | "evening" | "next-morning";
type Direction = "outbound" | "inbound";

/**
 * Pick which routes / direction / day to show. With no `want`, the time of day
 * decides (to the city until 3 PM, heading home until 8 PM, then tomorrow
 * morning). `want` pins the direction instead: the sign at home always asks
 * for "outbound" (it is only looked at when leaving), and the web page lets you
 * flip to the trip home at any hour.
 */
function pickMode(
  now: number,
  want: Direction | null
): {
  mode: Mode;
  direction: "outbound" | "inbound";
  boards: BoardDef[];
  dayFilter: DayFilter;
  minNyMinutes?: number;
  showLeave: boolean;
  headline: string;
} {
  const h = nyHour(now);
  if (want === "inbound") {
    return {
      mode: "evening",
      direction: "inbound",
      boards: INBOUND,
      // "any", not "today": late at night the next trains home leave after midnight.
      dayFilter: "any",
      showLeave: false,
      headline: "Heading home",
    };
  }
  if (want === "outbound" ? h < NEXT_MORNING_FROM : h < EVENING_FROM) {
    return {
      mode: "morning",
      direction: "outbound",
      boards: OUTBOUND,
      dayFilter: "today",
      showLeave: true,
      headline: "To NYC · today",
    };
  }
  if (want !== "outbound" && h < NEXT_MORNING_FROM) {
    return {
      mode: "evening",
      direction: "inbound",
      boards: INBOUND,
      dayFilter: "today",
      showLeave: false,
      headline: "Heading home · tonight",
    };
  }
  return {
    mode: "next-morning",
    direction: "outbound",
    boards: OUTBOUND,
    dayFilter: "tomorrow",
    minNyMinutes: MORNING_START_MIN,
    showLeave: true,
    headline: "To NYC · tomorrow morning",
  };
}

/** Resolve to `fallback` if `p` hasn't settled within `ms`. */
function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

export async function GET(req: Request) {
  // `?now=<epochMs>` overrides the clock for testing the time-of-day windows.
  // An overridden clock never touches live data or live traffic (they describe
  // the real present), and its response is never cached.
  const query = new URL(req.url).searchParams;
  const override = query.get("now");
  const overridden = override !== null;
  const now = overridden ? Number(override) : Date.now();
  if (!Number.isFinite(now) || now < 0 || now > 8.64e15) {
    return NextResponse.json(
      { error: "now must be epoch milliseconds" },
      { status: 400, headers: { "Cache-Control": "no-store" } }
    );
  }

  const wantDirection: Direction | null =
    query.get("direction") === "outbound"
      ? "outbound"
      : query.get("direction") === "inbound"
        ? "inbound"
        : null;
  const limitParam = Number.parseInt(query.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitParam)
    ? Math.min(MAX_TRAINS_PER_BOARD, Math.max(1, limitParam))
    : TRAINS_PER_BOARD;

  // The sign checking in. (Never for a test clock.)
  const device = overridden ? null : deviceId(query.get("device"));
  const heartbeatPromise = device ? recordHeartbeat(device) : Promise.resolve();

  const {
    mode,
    direction,
    boards: boardDefs,
    dayFilter,
    minNyMinutes,
    showLeave,
    headline,
  } = pickMode(now, wantDirection);

  // --- drive times -----------------------------------------------------------
  // Always real Google measurements (see lib/driving.ts): re-measured every few
  // minutes during the morning live hours, otherwise the most recent one. A
  // test clock never calls Google.
  const allowGoogle = !overridden;

  const commutePromise = driveToAddress("commute", commute.address, allowGoogle);

  // Drive-to-station / leave-by only applies to outbound (you drive from home
  // to the departure station). Compute once per unique origin station.
  const originIds = [...new Set(boardDefs.map((b) => b.origin))];
  const drivesPromise: Promise<[string, DriveEstimate | null][]> = showLeave
    ? Promise.all(
        originIds.map(
          async (id) =>
            [id, await driveTo(id, STATION_COORDS[id], allowGoogle)] as [
              string,
              DriveEstimate | null,
            ]
        )
      )
    : Promise.resolve([]);

  // --- live boards -----------------------------------------------------------
  // Real-time data only exists for the near term, so tomorrow's preview is
  // timetable-only; everything else is built from the live board.
  const wantLive = !overridden && dayFilter !== "tomorrow";
  const liveRequests: { code: string; variant: BoardVariant }[] = [];
  if (wantLive && hasCredentials()) {
    const seen = new Set<string>();
    for (const b of boardDefs) {
      for (const id of [b.origin, b.dest]) {
        const code = NJT_STATION_2CHAR[id];
        if (!code || seen.has(code)) continue;
        // Home stations: the full board (with stop lists) — the schedule itself.
        // City origins (evening): the light board, for track / boarding there.
        if (HOME_STATIONS.has(id)) {
          seen.add(code);
          liveRequests.push({ code, variant: "full" });
        } else if (id === b.origin) {
          seen.add(code);
          liveRequests.push({ code, variant: "light" });
        }
      }
    }
  }
  const livePromise = withDeadline(
    fetchStationBoards(liveRequests),
    LIVE_DEADLINE_MS,
    new Map<string, LiveTrain[] | null>()
  );

  const [commute, drives, liveBoards, signSeenMs] = await Promise.all([
    commutePromise,
    drivesPromise,
    livePromise,
    heartbeatPromise.then(() => lastSeen(SIGN_ID)),
  ]);
  const driveByOrigin = new Map(drives);

  // --- assemble ----------------------------------------------------------------
  let liveUsed = false;
  let liveMissing = false;

  const boards = boardDefs.map(({ origin, dest, short }) => {
    const homeIsOrigin = HOME_STATIONS.has(origin);
    const homeCode = NJT_STATION_2CHAR[homeIsOrigin ? origin : dest];
    const homeBoard = liveBoards.get(homeCode) ?? null;
    if (liveRequests.length > 0) {
      if (homeBoard === null) liveMissing = true;
    }

    const built = buildBoard({
      origin,
      dest,
      now,
      limit,
      dayFilter,
      minNyMinutes,
      homeIsOrigin,
      homeBoard,
      originBoard: homeIsOrigin ? null : liveBoards.get(NJT_STATION_2CHAR[origin]) ?? null,
    });
    if (built.source === "live") liveUsed = true;

    const drive = showLeave ? driveByOrigin.get(origin) ?? null : null;
    return {
      origin: STATION_NAMES[origin],
      dest: STATION_NAMES[dest],
      destShort: short,
      driveMin: drive ? Math.round(drive.sec / 60) : null,
      driveSource: drive ? drive.source : null,
      driveMeasuredAtMs: drive ? drive.measuredAt : null,
      source: built.source,
      departures: built.departures.map((d) => ({
        depEpochMs: d.depEpochMs,
        arrEpochMs: d.arrEpochMs,
        depTime: d.depTime,
        arrTime: d.arrTime,
        routeName: d.routeName,
        routeShort: d.routeShort,
        color: d.color,
        headsign: d.headsign,
        durationMin: d.durationMin,
        train: d.train,
        source: d.source,
        leaveByEpochMs: drive ? d.depEpochMs - drive.sec * 1000 - BUFFER_MS : null,
        live: d.live,
      })),
    };
  });

  const commute = {
    name: commute.name,
    driveMin: commute ? Math.round(commute.sec / 60) : null,
    driveSource: commute ? commute.source : null,
    driveMeasuredAtMs: commute ? commute.measuredAt : null,
    etaEpochMs: commute ? now + commute.sec * 1000 : null,
    // No origin: Google Maps starts from wherever the phone is, and the home
    // address never appears in this (public) response.
    mapsUrl:
      "https://www.google.com/maps/dir/?api=1" +
      `&destination=${encodeURIComponent(commute.address)}` +
      "&travelmode=driving",
  };

  // NJ Transit's own service alerts for these stations — they arrive with the
  // boards we already fetched.
  const alerts = wantLive
    ? stationAlerts(liveRequests.map((r) => r.code)).map((text) => ({ text }))
    : [];

  // What each data source is doing, so screens can say what's wrong instead of
  // showing a plausible-looking empty board.
  const driveSources = [...driveByOrigin.values()].map((d) => d?.source ?? null);
  const status = {
    schedule: scheduleStatus(now),
    // ok: live board in use · down: wanted but unavailable · off: not applicable
    live: !wantLive || !hasCredentials()
      ? ("off" as const)
      : liveMissing || !liveUsed
        ? ("down" as const)
        : ("ok" as const),
    drive: !showLeave
      ? ("off" as const)
      : driveSources.some((s) => s === "live")
        ? ("live" as const)
        : driveSources.some((s) => s === "earlier")
          ? ("earlier" as const)
          : ("none" as const),
    // When the E-Ink sign last asked for a board (null = never / unknown).
    device: { id: SIGN_ID, lastSeenMs: signSeenMs },
  };

  return NextResponse.json(
    {
      now,
      generatedAt: SCHEDULE_GENERATED_AT,
      bufferMin: BUFFER_MS / 60_000,
      mode,
      direction,
      showLeave,
      headline,
      status,
      alerts,
      commute,
      boards,
    },
    {
      headers: {
        // Let Vercel's edge answer bursts (several open tabs, the device) from
        // one computation, and keep serving the last good answer for a moment
        // if a recompute is slow. Short enough that countdowns stay honest.
        "Cache-Control": overridden
          ? "no-store"
          : "public, max-age=0, s-maxage=15, stale-while-revalidate=30",
      },
    }
  );
}
