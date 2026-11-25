import scheduleData from "@/data/schedule.json";

const TZ = "America/New_York";

export type Trip = {
  route: string;
  service: string;
  origin: string;
  dest: string;
  dep: string;
  arr: string;
  headsign: string;
  train?: string; // train number (GTFS block_id), for live-status matching
  ends?: boolean; // the trip's final stop is `dest` (it terminates there)
};

type StationCoord = { name: string; lat: number; lon: number };

export type Schedule = {
  generatedAt: string;
  source?: string;
  origins: Record<string, string>;
  destinations: Record<string, string>;
  coords: Record<string, StationCoord>;
  routes: Record<string, { name: string; short: string; color: string }>;
  trips: Trip[];
  calendar: Record<string, string[]>;
};

const bundled = scheduleData as Schedule;

export type Departure = {
  depEpochMs: number;
  arrEpochMs: number;
  depTime: string;
  arrTime: string;
  routeName: string;
  routeShort: string;
  color: string;
  headsign: string;
  durationMin: number;
  train: string; // train number, for joining live DepartureVision status
  endsAtDest: boolean; // terminates at the destination (see lib/board.ts)
};

// --- timezone helpers --------------------------------------------------------

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
export function nyWallToEpoch(
  y: number,
  mo: number, // 1-12; day/hour overflow is normalized (d + 1 past month end is fine)
  d: number,
  h = 0,
  mi = 0,
  s = 0
): number {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive - tzOffsetMs(new Date(naive));
  guess = naive - tzOffsetMs(new Date(guess));
  return guess;
}

/**
 * The instant GTFS times are measured from on a service day: "noon minus 12h".
 * That is local midnight on ordinary days, but on the two daylight-saving
 * changeover days it is an hour off local midnight — and using local midnight
 * there shifts every train that day by an hour.
 */
export function serviceDayAnchor(y: number, mo: number, d: number): number {
  return nyWallToEpoch(y, mo, d, 12) - 12 * 3600_000;
}

export function nyDateParts(epoch: number): { y: number; mo: number; d: number } {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day) };
}

function dateKey(y: number, mo: number, d: number): string {
  return `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}

/** YYYYMMDD of an instant's New York calendar date. */
export function nyDateKey(epoch: number): string {
  const { y, mo, d } = nyDateParts(epoch);
  return dateKey(y, mo, d);
}

function gtfsSeconds(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/** Minutes after midnight (0–1439) of an instant in New York. */
export function nyMinutesOf(epoch: number): number {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(epoch))) {
    p[part.type] = part.value;
  }
  const h = p.hour === "24" ? 0 : Number(p.hour);
  return h * 60 + Number(p.minute);
}

export function fmtTime(epoch: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epoch));
}

// --- main query --------------------------------------------------------------

export type BoardKey = { origin: string; dest: string };

export type DayFilter = "any" | "today" | "tomorrow";

/** True when `depEpochMs` passes the day / earliest-minute filters for `now`. */
export function passesDayFilter(
  depEpochMs: number,
  now: number,
  dayFilter: DayFilter,
  minNyMinutes?: number
): boolean {
  if (dayFilter !== "any") {
    const { y, mo, d } = nyDateParts(now);
    const wantKey =
      dayFilter === "today"
        ? dateKey(y, mo, d)
        : nyDateKey(nyWallToEpoch(y, mo, d + 1, 12));
    if (nyDateKey(depEpochMs) !== wantKey) return false;
  }
  if (minNyMinutes != null && nyMinutesOf(depEpochMs) < minNyMinutes) return false;
  return true;
}

/**
 * Next upcoming departures from `origin` to `dest`, computed against `now`
 * (epoch ms). Looks across yesterday/today/tomorrow service dates so that
 * after-midnight trips and early-morning trips both resolve correctly.
 *
 * `dayFilter` limits results by New York calendar date:
 *   - "today"    — only departures later today (empty once the day is done),
 *   - "tomorrow" — only departures on the next calendar day (next morning),
 *   - "any"      — the next upcoming departures regardless of day.
 *
 * `minNyMinutes`, when set, drops departures before that many minutes after
 * New York midnight (e.g. 390 = 6:30 AM) when previewing the next morning.
 *
 * `sched` defaults to the bundled data/schedule.json; tests pass a fixture.
 */
export function nextDepartures(
  origin: string,
  dest: string,
  now: number = Date.now(),
  limit = 4,
  dayFilter: DayFilter = "any",
  minNyMinutes?: number,
  sched: Schedule = bundled
): Departure[] {
  const trips = sched.trips.filter(
    (t) => t.origin === origin && t.dest === dest
  );

  const { y, mo, d } = nyDateParts(now);

  const candidates: Departure[] = [];
  for (const offset of [-1, 0, 1]) {
    const noon = nyWallToEpoch(y, mo, d + offset, 12);
    const anchor = noon - 12 * 3600_000; // GTFS service-day origin (DST-safe)
    const key = nyDateKey(noon);

    for (const trip of trips) {
      const dates = sched.calendar[trip.service];
      if (!dates || !dates.includes(key)) continue;

      const depEpochMs = anchor + gtfsSeconds(trip.dep) * 1000;
      if (depEpochMs < now) continue;
      if (!passesDayFilter(depEpochMs, now, dayFilter, minNyMinutes)) continue;

      const arrEpochMs = anchor + gtfsSeconds(trip.arr) * 1000;
      const route = sched.routes[trip.route];
      candidates.push({
        depEpochMs,
        arrEpochMs,
        depTime: fmtTime(depEpochMs),
        arrTime: fmtTime(arrEpochMs),
        routeName: route?.name ?? "",
        routeShort: route?.short ?? "",
        color: route?.color ?? "334155",
        headsign: trip.headsign,
        durationMin: Math.max(0, Math.round((arrEpochMs - depEpochMs) / 60000)),
        train: trip.train ?? "",
        endsAtDest: trip.ends === true,
      });
    }
  }

  // Dedup (a trip can match in two day windows) and sort by time.
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const k = `${c.depEpochMs}|${c.train}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.depEpochMs - b.depEpochMs)
    .slice(0, limit);
}

// --- schedule validity -------------------------------------------------------

export type ScheduleStatus = {
  generatedAt: string;
  validFrom: string | null; // YYYY-MM-DD, first service date in the timetable
  validThrough: string | null; // YYYY-MM-DD, last service date in the timetable
  daysLeft: number; // whole days of timetable left after today (negative = expired)
  expired: boolean; // today is outside the timetable — no trains can be shown
};

function isoDate(key: string): string {
  return `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}`;
}

/**
 * How much timetable is left. The bundled schedule only lists service dates
 * for a few months; once today falls outside that range every board comes back
 * empty, which looks exactly like "no trains today" unless we say otherwise.
 */
export function scheduleStatus(
  now: number = Date.now(),
  sched: Schedule = bundled
): ScheduleStatus {
  let min: string | null = null;
  let max: string | null = null;
  for (const dates of Object.values(sched.calendar)) {
    for (const d of dates) {
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
  }
  if (min === null || max === null) {
    return {
      generatedAt: sched.generatedAt,
      validFrom: null,
      validThrough: null,
      daysLeft: -1,
      expired: true,
    };
  }
  const today = nyDateKey(now);
  const toUtc = (k: string) =>
    Date.UTC(Number(k.slice(0, 4)), Number(k.slice(4, 6)) - 1, Number(k.slice(6, 8)));
  const daysLeft = Math.round((toUtc(max) - toUtc(today)) / 86_400_000);
  return {
    generatedAt: sched.generatedAt,
    validFrom: isoDate(min),
    validThrough: isoDate(max),
    daysLeft,
    expired: today > max || today < min,
  };
}

export const STATION_NAMES = {
  ...bundled.origins,
  ...bundled.destinations,
} as Record<string, string>;

/** Lat/lon per stop_id, for computing drive time to the departure station. */
export const STATION_COORDS = bundled.coords as Record<string, StationCoord>;

export const SCHEDULE_GENERATED_AT = bundled.generatedAt;

/** Route display info (name / short / color) for a GTFS route id. */
export function routeInfo(routeId: string, sched: Schedule = bundled) {
  return sched.routes[routeId];
}
