/**
 * Builds one board (origin -> dest) "live first":
 *
 *   - For as far ahead as NJ Transit's live board at the home station reaches
 *     (its next ~19 trains — typically 4–8 hours), the trains shown are the
 *     ones NJ Transit says it is actually running, with their real stop lists.
 *     A timetable train that isn't on the live board is not shown; a train on
 *     the live board that isn't in the timetable is. That is what keeps the
 *     board right on days with adjusted or emergency schedules.
 *   - Beyond that window, and whenever live data is unavailable, the bundled
 *     timetable (data/schedule.json) fills in.
 *
 * The live board of the *home* station (Morristown / Bernardsville) covers both
 * directions, because every train's stop list includes New York / Hoboken with
 * times — so one call per home station is enough for morning and evening.
 */

import {
  nextDepartures,
  passesDayFilter,
  fmtTime,
  type DayFilter,
  type Departure,
  type Schedule,
} from "./departures";
import {
  classify,
  findLiveTrain,
  normId,
  NJT_STATION_2CHAR,
  type LiveStatus,
  type LiveTrain,
} from "./njtransit";

export type BoardDeparture = Departure & {
  source: "live" | "schedule"; // where this train's times came from
  live: LiveStatus | null;
};

export type BuildBoardOpts = {
  origin: string; // GTFS stop ids
  dest: string;
  now: number;
  limit: number;
  dayFilter: DayFilter;
  minNyMinutes?: number;
  /** Which end is the home station (whose live board we hold). */
  homeIsOrigin: boolean;
  /** Full live board (with stops) at the home station; null = unavailable. */
  homeBoard: LiveTrain[] | null | undefined;
  /** Light live board at the origin when the origin is the city (evening) — for track / boarding there. */
  originBoard?: LiveTrain[] | null;
  schedule?: Schedule;
};

export type BuiltBoard = {
  departures: BoardDeparture[];
  /** "live" when the near-term list came from NJ Transit's live board. */
  source: "live" | "schedule";
};

// The live board is only trusted to *remove* timetable trains when it looks
// healthy; a degenerate response must not be able to blank the board.
const MIN_HEALTHY_TRAINS = 3;

const floorMin = (ms: number) => Math.floor(ms / 60_000) * 60_000;

/** Status for a train on an evening (city -> home) board. */
function inboundStatus(
  homeTrain: LiveTrain | null,
  originTrain: LiveTrain | null
): LiveStatus | null {
  // The home station's status line describes the train's arrival *there*
  // ("All Aboard", its platform) — not something to show someone boarding in
  // the city. Keep only what is true of the whole trip: cancelled / delayed.
  let base: LiveStatus | null = null;
  if (homeTrain) {
    base = classify(homeTrain);
    base.track = null;
    if (base.state === "boarding") {
      base.state = base.delayMin >= 1 ? "delayed" : "on-time";
    }
  }
  const atOrigin = originTrain ? classify(originTrain) : null;
  if (atOrigin && base?.state === "cancelled") {
    return { ...atOrigin, state: "cancelled" };
  }
  return atOrigin ?? base;
}

export function buildBoard(opts: BuildBoardOpts): BuiltBoard {
  const { origin, dest, now, limit, dayFilter, minNyMinutes, homeIsOrigin } = opts;
  const originCode = NJT_STATION_2CHAR[origin];
  const destCode = NJT_STATION_2CHAR[dest];
  const originBoard = opts.originBoard ?? null;

  // Timetable candidates — generously more than `limit`, so there are enough
  // left after the live window is carved out.
  const timetable = nextDepartures(
    origin,
    dest,
    now,
    limit + 40,
    dayFilter,
    minNyMinutes,
    opts.schedule
  );
  const homeTimeOf = (d: Departure) => (homeIsOrigin ? d.depEpochMs : d.arrEpochMs);

  const statusFor = (d: Departure, homeTrain: LiveTrain | null): LiveStatus | null => {
    if (homeIsOrigin) return homeTrain ? classify(homeTrain) : null;
    return inboundStatus(homeTrain, findLiveTrain(originBoard, d.depEpochMs, d.train));
  };

  const home = opts.homeBoard ?? null;
  const withStops = home ? home.filter((t) => t.stops && t.schedDepEpochMs != null) : [];
  const liveUsable =
    !!home && !!originCode && !!destCode && withStops.length >= MIN_HEALTHY_TRAINS;

  if (!liveUsable) {
    // Timetable only; still attach whatever live status we can match.
    const departures = timetable.slice(0, limit).map((d) => ({
      ...d,
      source: "schedule" as const,
      live: statusFor(
        d,
        homeIsOrigin ? findLiveTrain(home, d.depEpochMs, d.train) : null
      ),
    }));
    return { departures, source: "schedule" };
  }

  // How far ahead the live board reaches, in home-station time.
  const windowEnd = Math.max(...home!.map((t) => t.schedDepEpochMs ?? 0));
  const liveByTrain = new Map<string, LiveTrain>();
  for (const t of home!) {
    const id = normId(t.trainId);
    if (id && !liveByTrain.has(id)) liveByTrain.set(id, t);
  }
  const timetableByTrain = new Map<string, Departure>();
  for (const d of timetable) {
    const id = normId(d.train);
    if (id && !timetableByTrain.has(id)) timetableByTrain.set(id, d);
  }

  const out: BoardDeparture[] = [];
  // Train number -> its home-station time, for trains the live board accounts for.
  const usedTrains = new Map<string, number>();
  // The same train number runs again tomorrow; only treat a timetable entry as
  // "the same train" when it is also close in time.
  const SAME_RUN_MS = 3 * 3600_000;

  // 1) Trains from the live board that run origin -> dest.
  for (const t of withStops) {
    const stops = t.stops!;
    const oi = stops.findIndex((s) => s.code === originCode);
    const di = stops.findIndex((s) => s.code === destCode);
    if (oi < 0 || di < 0 || oi >= di) continue;
    const o = stops[oi];
    const d = stops[di];
    const id = normId(t.trainId);
    // From here on this train is accounted for by the live board, whether or
    // not it ends up listed (it may already have left).
    if (id) usedTrains.set(id, t.schedDepEpochMs ?? 0);

    if (o.departed || o.dischargeOnly) continue;
    if (o.schedEpochMs == null || d.schedEpochMs == null) continue;
    const depEpochMs = floorMin(o.schedEpochMs);
    const arrEpochMs = floorMin(d.schedEpochMs);
    // Still ahead of us: by the timetable, or because it is running late.
    const expected = Math.max(depEpochMs, o.estEpochMs ?? 0);
    if (expected < now - 60_000) continue;
    if (!passesDayFilter(depEpochMs, now, dayFilter, minNyMinutes)) continue;

    const tt = id ? timetableByTrain.get(id) : undefined;
    const dep: Departure = {
      depEpochMs,
      arrEpochMs,
      depTime: fmtTime(depEpochMs),
      arrTime: fmtTime(arrEpochMs),
      routeName: tt?.routeName ?? t.line,
      routeShort: tt?.routeShort ?? "",
      color: tt?.color ?? (t.color || "334155"),
      headsign: tt?.headsign ?? t.destination.toUpperCase(),
      durationMin: Math.max(0, Math.round((arrEpochMs - depEpochMs) / 60000)),
      train: t.trainId,
      endsAtDest: di === stops.length - 1,
    };
    out.push({ ...dep, source: "live", live: statusFor(dep, t) });
  }

  // 2) Timetable trains the live board doesn't account for.
  for (const d of timetable) {
    const id = normId(d.train);
    const usedAt = id ? usedTrains.get(id) : undefined;
    if (usedAt !== undefined && Math.abs(homeTimeOf(d) - usedAt) < SAME_RUN_MS) {
      continue; // already handled above
    }
    const liveTrain = id ? liveByTrain.get(id) ?? null : null;

    if (homeTimeOf(d) > windowEnd) {
      // Beyond what the live board covers yet: the timetable is all we have.
      out.push({ ...d, source: "schedule", live: statusFor(d, null) });
      continue;
    }
    if (liveTrain) {
      // On the live board. With a stop list it was handled in step 1 — and if
      // it wasn't listed there, today it doesn't run origin -> dest. Without a
      // stop list we can't tell, so keep the timetable's word plus live status.
      if (!liveTrain.stops) {
        out.push({ ...d, source: "schedule", live: statusFor(d, liveTrain) });
      }
      continue;
    }
    // Inside the live window but not on the live board. A train that *ends* at
    // the home station never appears on that station's departure board, so it
    // can't be judged this way; anything else isn't running today.
    if (!homeIsOrigin && d.endsAtDest) {
      out.push({ ...d, source: "schedule", live: statusFor(d, null) });
    }
  }

  out.sort((a, b) => a.depEpochMs - b.depEpochMs);
  return { departures: out.slice(0, limit), source: "live" };
}
