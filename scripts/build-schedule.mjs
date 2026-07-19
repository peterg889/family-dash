#!/usr/bin/env node
/**
 * Build a compact rail schedule from NJ Transit's GTFS static feed.
 *
 * Reads the GTFS rail zip (downloads it from the public Mobility Database
 * mirror if not provided), keeps only the trips that run between the
 * stations we care about, and writes data/schedule.json.
 *
 * Usage:
 *   node scripts/build-schedule.mjs              # download latest feed
 *   GTFS_ZIP=/path/to/rail.zip node scripts/build-schedule.mjs
 *
 * No API key / registration required — GTFS static is a public feed.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// Public mirror of NJ Transit Rail GTFS (Mobility Database source #509).
const FEED_URL =
  "https://storage.googleapis.com/storage/v1/b/mdb-latest/o/us-new-jersey-new-jersey-transit-nj-transit-gtfs-509.zip?alt=media";

// Stations of interest. stop_id values come from the feed's stops.txt.
const ORIGINS = {
  "92": "Morristown",
  "18": "Bernardsville",
};
const DESTINATIONS = {
  "105": "New York Penn Station",
  "63": "Hoboken",
};

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
  const rows = parseCsv(text);
  const header = rows[0];
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
// Load GTFS files (unzipped to a temp dir via the `unzip` CLI).
// ---------------------------------------------------------------------------
function loadGtfs() {
  const dir = mkdtempSync(join(tmpdir(), "njgtfs-"));
  let zipPath = process.env.GTFS_ZIP;
  if (zipPath && existsSync(zipPath)) {
    console.log(`Using local GTFS zip: ${zipPath}`);
  } else {
    zipPath = join(dir, "rail.zip");
    console.log("Downloading NJ Transit rail GTFS feed…");
    execFileSync("curl", ["-sL", "--max-time", "300", FEED_URL, "-o", zipPath]);
  }
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

// ---------------------------------------------------------------------------
// Build the compact schedule.
// ---------------------------------------------------------------------------
function main() {
  const { routes, trips, stops, stopTimes, calendarDates } = loadGtfs();

  // Lat/lon for the stations we care about — used to compute drive time from
  // home to the departure station ("leave by").
  const watchedStops = new Set([
    ...Object.keys(ORIGINS),
    ...Object.keys(DESTINATIONS),
  ]);
  const coords = {};
  for (const s of stops) {
    if (!watchedStops.has(s.stop_id)) continue;
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

  // Group stop_times by trip, keeping only stops we care about.
  const watched = new Set([...Object.keys(ORIGINS), ...Object.keys(DESTINATIONS)]);
  const byTrip = new Map();
  for (const st of stopTimes) {
    if (!watched.has(st.stop_id)) continue;
    if (!byTrip.has(st.trip_id)) byTrip.set(st.trip_id, []);
    byTrip.get(st.trip_id).push({
      stop: st.stop_id,
      seq: Number(st.stop_sequence),
      dep: st.departure_time,
      arr: st.arrival_time,
    });
  }

  const outTrips = [];
  const usedServices = new Set();
  const usedRoutes = new Set();

  for (const [tripId, stops] of byTrip) {
    stops.sort((a, b) => a.seq - b.seq);
    // A trip serves at most one suburb (Morristown/Bernardsville are on
    // different branches) and one city (it terminates at NY Penn or Hoboken).
    // Whichever comes first in the stop sequence is the origin — so we capture
    // the trip in whichever direction it actually runs (outbound or inbound).
    const suburb = stops.find((s) => ORIGINS[s.stop]);
    const city = stops.find((s) => DESTINATIONS[s.stop]);
    if (!suburb || !city) continue;
    const [origin, dest] =
      suburb.seq < city.seq ? [suburb, city] : [city, suburb];

    const trip = tripById[tripId];
    if (!trip) continue;

    outTrips.push({
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
    });
    usedServices.add(trip.service_id);
    usedRoutes.add(trip.route_id);
  }

  // Active service dates, limited to the services we actually use.
  const calendar = {};
  for (const cd of calendarDates) {
    if (cd.exception_type !== "1") continue; // 1 = service added on this date
    if (!usedServices.has(cd.service_id)) continue;
    (calendar[cd.service_id] ||= []).push(cd.date);
  }
  for (const k of Object.keys(calendar)) calendar[k].sort();

  const routesOut = {};
  for (const id of usedRoutes) routesOut[id] = routeById[id];

  const schedule = {
    generatedAt: new Date().toISOString(),
    origins: ORIGINS,
    destinations: DESTINATIONS,
    coords,
    routes: routesOut,
    trips: outTrips,
    calendar,
  };

  writeFileSync(
    join(process.cwd(), "data", "schedule.json"),
    JSON.stringify(schedule)
  );

  console.log(
    `Wrote data/schedule.json — ${outTrips.length} trips, ` +
      `${Object.keys(calendar).length} services, ` +
      `${Object.keys(routesOut).length} routes.`
  );
}

main();
