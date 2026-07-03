#!/usr/bin/env node
// Reference oracle for the departures port: a faithful copy of
// lib/departures.ts `nextDepartures` (Intl-based NY timezone math), run over
// the timestamps in the file given as argv[2]. Emits one canonical line per
// (timestamp, board):
//
//   <epochSec> B<boardIdx> dep|routeShort|headsign|dur ; dep|...
//
// Compared byte-for-byte against the C++ port's output.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const schedule = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "data", "schedule.json"), "utf8")
);

const TZ = "America/New_York";

// Board order mirrors app/api/departures/route.ts.
const BOARDS = [
  { origin: "92", dest: "105" },
  { origin: "92", dest: "63" },
  { origin: "18", dest: "105" },
  { origin: "18", dest: "63" },
];

// ---- verbatim helpers from lib/departures.ts --------------------------------
function tzOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(date)) p[part.type] = part.value;
  const hour = p.hour === "24" ? 0 : Number(p.hour);
  const asUTC = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day),
    hour, Number(p.minute), Number(p.second));
  return asUTC - date.getTime();
}
function nyLocalEpoch(y, mo, d, hour) {
  const naive = Date.UTC(y, mo - 1, d, hour, 0, 0);
  let guess = naive - tzOffsetMs(new Date(naive));
  guess = naive - tzOffsetMs(new Date(guess));
  return guess;
}
function nyDateParts(epoch) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(epoch))) p[part.type] = part.value;
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.d ?? p.day) };
}
function dateKey(y, mo, d) {
  return `${y}${String(mo).padStart(2, "0")}${String(d).padStart(2, "0")}`;
}
function gtfsSeconds(t) {
  const [h, m, s] = t.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}
function nextDepartures(origin, dest, now, limit = 4) {
  const trips = schedule.trips.filter((t) => t.origin === origin && t.dest === dest);
  const { y, mo, d } = nyDateParts(now);
  const candidates = [];
  for (const offset of [-1, 0, 1]) {
    const dayNoon = nyLocalEpoch(y, mo, d + offset, 12);
    const parts = nyDateParts(dayNoon);
    const key = dateKey(parts.y, parts.mo, parts.d);
    const dayAnchor = dayNoon - 12 * 3600_000;
    for (const trip of trips) {
      const dates = schedule.calendar[trip.service];
      if (!dates || !dates.includes(key)) continue;
      const depEpochMs = dayAnchor + gtfsSeconds(trip.dep) * 1000;
      if (depEpochMs < now) continue;
      const arrEpochMs = dayAnchor + gtfsSeconds(trip.arr) * 1000;
      const route = schedule.routes[trip.route];
      candidates.push({
        depEpochMs, arrEpochMs,
        routeShort: route?.short ?? "",
        headsign: trip.headsign,
        durationMin: Math.max(0, Math.round((arrEpochMs - depEpochMs) / 60000)),
      });
    }
  }
  const seen = new Set();
  return candidates
    .filter((c) => (seen.has(c.depEpochMs) ? false : seen.add(c.depEpochMs)))
    .sort((a, b) => a.depEpochMs - b.depEpochMs)
    .slice(0, limit);
}

export { nextDepartures, nyLocalEpoch, schedule, BOARDS };

// ---- runner (only when invoked with a cases file) ---------------------------
const casesFile = process.argv[2];
if (casesFile) {
  const epochs = readFileSync(casesFile, "utf8").trim().split("\n").map(Number);
  const lines = [];
  for (const sec of epochs) {
    const nowMs = sec * 1000;
    BOARDS.forEach((b, bi) => {
      const deps = nextDepartures(b.origin, b.dest, nowMs, 4);
      const parts = deps.map(
        (dv) =>
          `${Math.round(dv.depEpochMs / 1000)}|${dv.routeShort}|${dv.headsign}|${dv.durationMin}`
      );
      lines.push(`${sec} B${bi} ${parts.join(" ; ")}`);
    });
  }
  process.stdout.write(lines.join("\n") + "\n");
}
