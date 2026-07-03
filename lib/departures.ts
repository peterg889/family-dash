import scheduleData from "@/data/schedule.json";

const TZ = "America/New_York";

type Trip = {
  route: string;
  service: string;
  origin: string;
  dest: string;
  dep: string;
  arr: string;
  headsign: string;
};

type StationCoord = { name: string; lat: number; lon: number };

type Schedule = {
  generatedAt: string;
  origins: Record<string, string>;
  destinations: Record<string, string>;
  coords: Record<string, StationCoord>;
  routes: Record<string, { name: string; short: string; color: string }>;
  trips: Trip[];
  calendar: Record<string, string[]>;
};

const schedule = scheduleData as Schedule;

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

/** Epoch ms for midnight (00:00:00) of the given NY calendar date. */
function nyMidnightEpoch(y: number, mo: number, d: number): number {
  const naive = Date.UTC(y, mo - 1, d, 0, 0, 0);
  // Two passes converge even across DST boundaries.
  let guess = naive - tzOffsetMs(new Date(naive));
  guess = naive - tzOffsetMs(new Date(guess));
  return guess;
}

function nyDateParts(epoch: number): { y: number; mo: number; d: number } {
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

function gtfsSeconds(t: string): number {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

/** Minutes after midnight (0–1439) of an instant in New York. */
function nyMinutesOf(epoch: number): number {
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

function fmtTime(epoch: number): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(epoch));
}

// --- main query --------------------------------------------------------------

export type BoardKey = { origin: string; dest: string };

export type DayFilter = "any" | "today" | "tomorrow";

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
 */
export function nextDepartures(
  origin: string,
  dest: string,
  now: number = Date.now(),
  limit = 4,
  dayFilter: DayFilter = "any",
  minNyMinutes?: number
): Departure[] {
  const trips = schedule.trips.filter(
    (t) => t.origin === origin && t.dest === dest
  );

  const { y, mo, d } = nyDateParts(now);
  const todayKey = dateKey(y, mo, d);
  const tomParts = nyDateParts(nyMidnightEpoch(y, mo, d + 1) + 12 * 3600_000);
  const tomorrowKey = dateKey(tomParts.y, tomParts.mo, tomParts.d);

  const candidates: Departure[] = [];
  for (const offset of [-1, 0, 1]) {
    const dayMidnight = nyMidnightEpoch(y, mo, d + offset);
    const parts = nyDateParts(dayMidnight + 12 * 3600_000); // noon, DST-safe
    const key = dateKey(parts.y, parts.mo, parts.d);

    for (const trip of trips) {
      const dates = schedule.calendar[trip.service];
      if (!dates || !dates.includes(key)) continue;

      const depEpochMs = dayMidnight + gtfsSeconds(trip.dep) * 1000;
      if (depEpochMs < now) continue;

      if (dayFilter !== "any") {
        const dp = nyDateParts(depEpochMs);
        const depKey = dateKey(dp.y, dp.mo, dp.d);
        const wantKey = dayFilter === "today" ? todayKey : tomorrowKey;
        if (depKey !== wantKey) continue;
      }

      if (minNyMinutes != null && nyMinutesOf(depEpochMs) < minNyMinutes)
        continue;

      const arrEpochMs = dayMidnight + gtfsSeconds(trip.arr) * 1000;
      const route = schedule.routes[trip.route];
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
      });
    }
  }

  // Dedup (a trip can match in two day windows) and sort by time.
  const seen = new Set<number>();
  return candidates
    .filter((c) => (seen.has(c.depEpochMs) ? false : seen.add(c.depEpochMs)))
    .sort((a, b) => a.depEpochMs - b.depEpochMs)
    .slice(0, limit);
}

export const STATION_NAMES = {
  ...schedule.origins,
  ...schedule.destinations,
} as Record<string, string>;

/** Lat/lon per stop_id, for computing drive time to the departure station. */
export const STATION_COORDS = schedule.coords as Record<string, StationCoord>;

export const SCHEDULE_GENERATED_AT = schedule.generatedAt;
