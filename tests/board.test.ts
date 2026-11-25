import { describe, expect, it, vi } from "vitest";
import { mockNextCache } from "./helpers";

vi.mock("next/cache", () => mockNextCache());

import { buildBoard, type BuildBoardOpts } from "@/lib/board";
import { parseNjtDate, parseStationBoard, type LiveTrain } from "@/lib/njtransit";
import type { Schedule } from "@/lib/departures";
import scheduleFixture from "./fixtures/schedule-2026-11-25.json";
import mrRaw from "./fixtures/live-board-MR-2026-11-25.json";
import bvRaw from "./fixtures/live-board-BV-2026-11-25.json";

// Real data, captured Wed 25 Nov 2026 at about 10:24 AM: NJ Transit's live
// boards for Morristown and Bernardsville, and the timetable built that day.
const schedule = scheduleFixture as Schedule;
const MR = parseStationBoard(mrRaw)!;
const BV = parseStationBoard(bvRaw)!;
const NOW = parseNjtDate("25-Nov-2026 10:24:00 AM")!;

const build = (over: Partial<BuildBoardOpts>) =>
  buildBoard({
    origin: "92",
    dest: "105",
    now: NOW,
    limit: 5,
    dayFilter: "today",
    homeIsOrigin: true,
    homeBoard: MR,
    schedule,
    ...over,
  });
const trains = (b: ReturnType<typeof buildBoard>) => b.departures.map((d) => d.train);
const withTrips = (edit: (trips: Schedule["trips"]) => Schedule["trips"]): Schedule => ({
  ...schedule,
  trips: edit(schedule.trips.map((t) => ({ ...t }))),
});

describe("buildBoard — live first", () => {
  it("lists the trains NJ Transit is actually running, at timetable-style minutes", () => {
    const b = build({});
    expect(b.source).toBe("live");
    expect(trains(b)).toEqual(["6632", "6636", "6640", "6644", "6648"]);
    expect(b.departures.every((d) => d.source === "live")).toBe(true);
    // The live feed says 11:11:30; the board shows the timetable minute.
    expect(b.departures[1]).toMatchObject({ depTime: "11:11 AM", arrTime: "12:21 PM", durationMin: 70 });
    expect(b.departures[0].live).toMatchObject({ state: "on-time", track: "2" });
  });

  it("agrees with the timetable on an ordinary day", () => {
    const live = build({ limit: 9 });
    const timetable = build({ limit: 9, homeBoard: null });
    expect(timetable.source).toBe("schedule");
    expect(live.departures.map((d) => [d.train.replace(/^0+/, ""), d.depEpochMs, d.arrEpochMs])).toEqual(
      timetable.departures.map((d) => [d.train.replace(/^0+/, ""), d.depEpochMs, d.arrEpochMs])
    );
  });

  it("drops a timetable train that isn't on the live board (adjusted schedule)", () => {
    const ghost = withTrips((trips) => [
      ...trips,
      { route: "7", service: trips.find((t) => t.train === "6636")!.service, origin: "92", dest: "105", dep: "11:30:00", arr: "12:40:00", headsign: "NEW YORK", train: "9999" },
    ]);
    expect(trains(build({ schedule: ghost, limit: 9 }))).not.toContain("9999");
    // Without live data the timetable is all we have, so it stays.
    expect(trains(build({ schedule: ghost, limit: 9, homeBoard: null }))).toContain("9999");
  });

  it("shows a train that is running today but missing from the timetable", () => {
    const missing = withTrips((trips) => trips.filter((t) => t.train !== "6636"));
    const b = build({ schedule: missing });
    expect(trains(b)).toContain("6636");
    expect(b.departures.find((d) => d.train === "6636")).toMatchObject({ source: "live", depTime: "11:11 AM" });
  });

  it("continues from the timetable beyond what the live board covers", () => {
    const b = build({ limit: 14 });
    const sources = b.departures.map((d) => d.source);
    expect(sources.slice(0, 9).every((s) => s === "live")).toBe(true);
    expect(sources.slice(9).every((s) => s === "schedule")).toBe(true);
    expect(sources.length).toBeGreaterThan(9);
    // Strictly increasing, no train listed twice across the seam.
    const deps = b.departures.map((d) => d.depEpochMs);
    expect([...deps].sort((a, z) => a - z)).toEqual(deps);
    expect(new Set(trains(b).map((t) => t.replace(/^0+/, ""))).size).toBe(b.departures.length);
  });

  it("keeps a late train on the board until it has actually left", () => {
    // 10:30 AM: the 10:27 is past its time but running 6 minutes late.
    const late: LiveTrain[] = MR.map((t) =>
      t.trainId === "6632"
        ? { ...t, secLate: 360, stops: t.stops!.map((s) => (s.code === "MR" ? { ...s, estEpochMs: s.schedEpochMs! + 360_000 } : s)) }
        : t
    );
    const b = build({ now: NOW + 6 * 60_000, homeBoard: late });
    expect(b.departures[0]).toMatchObject({ train: "6632", live: { state: "delayed", delayMin: 6 } });
    // Once it's marked departed, it's gone.
    const gone = late.map((t) =>
      t.trainId === "6632" ? { ...t, stops: t.stops!.map((s) => (s.code === "MR" ? { ...s, departed: true } : s)) } : t
    );
    expect(trains(build({ now: NOW + 6 * 60_000, homeBoard: gone }))[0]).toBe("6636");
  });

  it("keeps cancelled trains listed, marked cancelled", () => {
    const cancelled = MR.map((t) => (t.trainId === "6636" ? { ...t, status: "CANCELLED" } : t));
    expect(build({ homeBoard: cancelled }).departures[1]).toMatchObject({ train: "6636", live: { state: "cancelled" } });
  });

  it("won't let a degenerate live response blank the board", () => {
    const b = build({ homeBoard: MR.slice(0, 2) });
    expect(b.source).toBe("schedule");
    expect(b.departures).toHaveLength(5);
    expect(b.departures[0].live).not.toBeNull(); // live status still attached where it matches
  });

  it("falls back to the timetable when a live train has no stop list", () => {
    const noStops = MR.map((t) => (t.trainId === "6636" ? { ...t, stops: null } : t));
    const d = build({ homeBoard: noStops }).departures.find((x) => x.train.replace(/^0+/, "") === "6636");
    expect(d).toMatchObject({ source: "schedule", depTime: "11:11 AM" });
    expect(d!.live).not.toBeNull();
  });
});

describe("buildBoard — evening (city to home) from the home station's board", () => {
  const evening = (over: Partial<BuildBoardOpts>) =>
    build({ origin: "105", dest: "92", homeIsOrigin: false, ...over });

  it("leaves out trains that have already left the city", () => {
    // 6619 left New York at 10:04; next to leave is the 10:46.
    const b = evening({});
    expect(trains(b)).not.toContain("6619");
    expect(b.departures[0]).toMatchObject({ train: "6621", depTime: "10:46 AM", arrTime: "11:52 AM", source: "live" });
  });

  it("doesn't show the home station's platform or 'all aboard' as if it were Penn's", () => {
    const atHome = MR.map((t) => (t.trainId === "6621" ? { ...t, status: "All Aboard", track: "1" } : t));
    expect(evening({ homeBoard: atHome }).departures[0].live).toMatchObject({ state: "on-time", track: null });
  });

  it("takes track and boarding from the city station's board when it has the train", () => {
    const penn: LiveTrain[] = [
      { schedDepEpochMs: parseNjtDate("25-Nov-2026 10:46:00 AM"), destination: "Dover", track: "9", line: "", trainId: "6621", status: "BOARDING", secLate: 0, color: "", stops: null },
    ];
    expect(evening({ originBoard: penn }).departures[0].live).toMatchObject({ state: "boarding", track: "9" });
  });

  it("keeps a train that terminates at the home station, which its live board never lists", () => {
    // Train 485 Hoboken -> Bernardsville (3:37 PM) ends at Bernardsville.
    const b = build({ origin: "63", dest: "18", homeIsOrigin: false, homeBoard: BV, limit: 12 });
    expect(b.source).toBe("live");
    const t485 = b.departures.find((d) => d.train.replace(/^0+/, "") === "485");
    expect(t485).toMatchObject({ depTime: "3:37 PM", source: "schedule" });
  });
});
