#!/usr/bin/env node
/**
 * Build a compact rail timetable from NJ Transit's GTFS static feed.
 *
 * Downloads NJ Transit's own rail GTFS zip, keeps only the trips that run
 * between the stations we care about, and writes data/schedule.json.
 *
 * Usage:
 *   node scripts/build-schedule.mjs              # download the latest feed and rebuild
 *   GTFS_ZIP=/path/to/rail.zip node scripts/build-schedule.mjs
 *   node scripts/build-schedule.mjs --check      # no download: exit 1 if the bundled
 *                                                # timetable has < MIN_DAYS_LEFT days left
 *
 * The build refuses to overwrite a good file with a worse one: a feed that is
 * already (nearly) expired, or that is missing whole boards, exits non-zero and
 * leaves data/schedule.json alone. When nothing but the timestamp would change,
 * the file is left untouched unless it is older than REFRESH_STAMP_DAYS.
 *
 * No API key / registration required — GTFS static is a public feed. (The live
 * board in lib/njtransit.ts is what tracks day-of changes; this file is the
 * fallback and the source for tomorrow-morning previews.)
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "schedule.json");

// NJ Transit's own download comes first. The Mobility Database mirror is only a
// fallback: it has been seen serving a feed months out of date.
const FEEDS = [
  { name: "njtransit.com", url: "https://www.njtransit.com/rail_data.zip" },
  {
    name: "mobilitydatabase mirror",
    url: "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-new-jersey-new-jersey-transit-nj-transit-gtfs-509.zip?alt=media",
  },
];

// A timetable with less than this many days left is a problem worth failing on.
const MIN_DAYS_LEFT = 14;
// Rewrite the file (fresh generatedAt) at least this often even if the trips
// are unchanged — proof the refresh job is alive, and it keeps GitHub from
// disabling the scheduled workflow for inactivity.
const REFRESH_STAMP_DAYS = 30;

// Stations of interest. stop_id values come from the feed's stops.txt.
const ORIGINS = {
  "92": "Morristown",
  "18": "Bernardsville",
};
const DESTINATIONS = {
  "105": "New York Penn Station",
  "63": "Hoboken",
};
// Every board the app shows must have at least one trip in a usable feed.
const REQUIRED_PAIRS = [
  ["92", "105"],
  ["18", "63"],
  ["105", "92"],
  ["63", "18"],
];

// ---------------------------------------------------------------------------
// Tiny CSV parser (handles quoted fields containing commas/quotes).
// ---------------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function parseTable(text) {
  const rows = parseCsv(text.replace(/^﻿/, ""));
  const header = rows[0].map((h) => h.trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j];
    out.push(obj);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
function nyToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replaceAll("-", "");
}
const toUtc = (k) => Date.UTC(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
const daysBetween = (a, b) => Math.round((toUtc(b) - toUtc(a)) / 86_400_000);

function validity(schedule) {
  let min = null;
  let max = null;
  for (const dates of Object.values(schedule.calendar)) {
    for (const d of dates) {
      if (min === null || d < min) min = d;
      if (max === null || d > max) max = d;
    }
  }
  return { min, max, daysLeft: max ? daysBetween(nyToday(), max) : -1 };
}

// ---------------------------------------------------------------------------
// Load GTFS files (unzipped to a temp dir via the `unzip` CLI).
// ---------------------------------------------------------------------------
function readGtfs(zipPath) {
  const dir = mkdtempSync(join(tmpdir(), "njgtfs-"));
  execFileSync("unzip", ["-o", zipPath, "-d", dir], { stdio: "ignore" });
  const read = (name) => parseTable(readFileSync(join(dir, name), "utf8"));
  return {
    routes: read("routes.txt"),
    trips: read("trips.txt"),
    stops: read("stops.txt"),
    stopTimes: read("stop_times.txt"),
    calendarDates: read("calendar_dates.txt"),
  };
}

function download(url) {
  const zipPath = join(mkdtempSync(join(tmpdir(), "njgtfs-dl-")), "rail.zip");
  execFileSync("curl", [
    "-sfL",
    "--max-time",
    "300",
    "-A",
    "Mozilla/5.0 (family-dash schedule refresh)",
    url,
    "-o",
    zipPath,
  ]);
  if (statSync(zipPath).size < 100_000) throw new Error("download too small to be a GTFS feed");
  return zipPath;
}

// ---------------------------------------------------------------------------
// Build the compact schedule.
// ---------------------------------------------------------------------------
function build({ routes, trips, stops, stopTimes, calendarDates }, source) {
  // Lat/lon for the stations we care about — used to compute drive time from
  // home to the departure station ("leave by").
  const watched = new Set([...Object.keys(ORIGINS), ...Object.keys(DESTINATIONS)]);
  const coords = {};
  for (const s of stops) {
    if (!watched.has(s.stop_id)) continue;
    coords[s.stop_id] = {
      name: s.stop_name,
      lat: Number(s.stop_lat),
      lon: Number(s.stop_lon),
    };
  }

  const routeById = {};
  for (const r of routes) {
    routeById[r.route_id] = {
      name: r.route_long_name,
      short: r.route_short_name,
      color: r.route_color || "334155",
    };
  }

  const tripById = {};
  for (const t of trips) tripById[t.trip_id] = t;

  // Group stop_times by trip, keeping only stops we care about — and note each
  // trip's final stop, so we know which trains terminate at a home station.
  const byTrip = new Map();
  const lastStop = new Map(); // trip_id -> { seq, stop }
  for (const st of stopTimes) {
    const seq = Number(st.stop_sequence);
    const last = lastStop.get(st.trip_id);
    if (!last || seq > last.seq) lastStop.set(st.trip_id, { seq, stop: st.stop_id });
    if (!watched.has(st.stop_id)) continue;
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push({
      stop: st.stop_id,
      seq,
      dep: st.departure_time,
      arr: st.arrival_time,
    });
  }

  const outTrips = [];
  const usedServices = new Set();
  const usedRoutes = new Set();

  for (const [tripId, tripStops] of byTrip) {
    tripStops.sort((a, b) => a.seq - b.seq);
    // A trip serves at most one suburb (Morristown/Bernardsville are on
    // different branches) and one city (it terminates at NY Penn or Hoboken).
    // Whichever comes first in the stop sequence is the origin — so we capture
    // the trip in whichever direction it actually runs (outbound or inbound).
    const suburb = tripStops.find((s) => ORIGINS[s.stop]);
    const city = tripStops.find((s) => DESTINATIONS[s.stop]);
    if (!suburb || !city) continue;
    const [origin, dest] = suburb.seq < city.seq ? [suburb, city] : [city, suburb];

    const trip = tripById[tripId];
    if (!trip) continue;

    const out = {
      route: trip.route_id,
      service: trip.service_id,
      origin: origin.stop,
      dest: dest.stop,
      dep: origin.dep, // departure time at the origin station
      arr: dest.arr, // arrival time at the destination
      headsign: trip.trip_headsign,
      // Train number (e.g. "6912") — matches the live DepartureVision TRAIN_ID,
      // so real-time status can be joined to the right train unambiguously. NJT
      // GTFS carries it in block_id (trip_short_name is empty in this feed).
      train: trip.block_id || "",
    };
    // A train that ends at `dest` never shows on that station's live departure
    // board, so lib/board.ts must not read its absence there as "not running".
    if (lastStop.get(tripId)?.stop === dest.stop) out.ends = true;
    outTrips.push(out);
    usedServices.add(trip.service_id);
    usedRoutes.add(trip.route_id);
  }

  // Stable order, so an unchanged feed produces an identical file.
  outTrips.sort(
    (a, b) =>
      a.origin.localeCompare(b.origin) ||
      a.dest.localeCompare(b.dest) ||
      a.dep.localeCompare(b.dep) ||
      a.service.localeCompare(b.service) ||
      a.train.localeCompare(b.train)
  );

  // Active service dates, limited to the services we actually use.
  const calendar = {};
  for (const cd of calendarDates) {
    if (cd.exception_type !== "1") continue; // 1 = service added on this date
    if (!usedServices.has(cd.service_id)) continue;
    (calendar[cd.service_id] ||= []).push(cd.date);
  }
  const sortedCalendar = {};
  for (const k of Object.keys(calendar).sort()) sortedCalendar[k] = calendar[k].sort();

  const routesOut = {};
  for (const id of [...usedRoutes].sort()) routesOut[id] = routeById[id];

  return {
    generatedAt: new Date().toISOString(),
    source,
    origins: ORIGINS,
    destinations: DESTINATIONS,
    coords,
    routes: routesOut,
    trips: outTrips,
    calendar: sortedCalendar,
  };
}

/** Why this schedule shouldn't be shipped, or null if it's fine. */
function problem(schedule) {
  for (const [o, d] of REQUIRED_PAIRS) {
    if (!schedule.trips.some((t) => t.origin === o && t.dest === d)) {
      return `no trips from ${o} to ${d}`;
    }
  }
  const v = validity(schedule);
  if (!v.max) return "no service dates";
  if (v.daysLeft < MIN_DAYS_LEFT) {
    return `timetable ends ${v.max} — only ${v.daysLeft} day(s) left`;
  }
  return null;
}

const sameContent = (a, b) =>
  JSON.stringify({ ...a, generatedAt: 0, source: 0 }) ===
  JSON.stringify({ ...b, generatedAt: 0, source: 0 });

// ---------------------------------------------------------------------------
function check() {
  const current = JSON.parse(readFileSync(OUT, "utf8"));
  const v = validity(current);
  console.log(
    `data/schedule.json: generated ${current.generatedAt}, service dates ${v.min}..${v.max}, ${v.daysLeft} day(s) left`
  );
  if (v.daysLeft < MIN_DAYS_LEFT) {
    console.error(
      `::error::The bundled timetable has ${v.daysLeft} day(s) left (need ${MIN_DAYS_LEFT}). ` +
        "Run `npm run build:schedule` and push, or check why the refresh job can't get a newer feed."
    );
    process.exit(1);
  }
}

function main() {
  if (process.argv.includes("--check")) return check();

  const candidates = [];
  if (process.env.GTFS_ZIP && existsSync(process.env.GTFS_ZIP)) {
    candidates.push({ name: "local zip", zip: () => process.env.GTFS_ZIP });
  } else {
    for (const f of FEEDS) candidates.push({ name: f.name, zip: () => download(f.url) });
  }

  let schedule = null;
  for (const c of candidates) {
    try {
      console.log(`Fetching NJ Transit rail GTFS from ${c.name}…`);
      const built = build(readGtfs(c.zip()), c.name);
      const why = problem(built);
      if (why) {
        console.warn(`  rejected: ${why}`);
        continue;
      }
      schedule = built;
      break;
    } catch (e) {
      console.warn(`  failed: ${e.message}`);
    }
  }
  if (!schedule) {
    console.error("::error::No usable GTFS feed — data/schedule.json left unchanged.");
    process.exit(1);
  }

  const v = validity(schedule);
  if (existsSync(OUT)) {
    const current = JSON.parse(readFileSync(OUT, "utf8"));
    const ageDays = (Date.now() - Date.parse(current.generatedAt)) / 86_400_000;
    if (sameContent(current, schedule) && ageDays < REFRESH_STAMP_DAYS) {
      console.log(
        `Timetable unchanged (service dates ${v.min}..${v.max}, ${v.daysLeft} days left) — file left as is.`
      );
      return;
    }
  }

  writeFileSync(OUT, JSON.stringify(schedule));
  console.log(
    `Wrote data/schedule.json from ${schedule.source} — ${schedule.trips.length} trips, ` +
      `${Object.keys(schedule.calendar).length} services, ` +
      `service dates ${v.min}..${v.max} (${v.daysLeft} days left).`
  );
}

main();
