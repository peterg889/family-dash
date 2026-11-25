import { describe, expect, it } from "vitest";
import bundled from "@/data/schedule.json";
import {
  nextDepartures,
  scheduleStatus,
  serviceDayAnchor,
  type Schedule,
} from "@/lib/departures";
import { utc } from "./helpers";

// A tiny hand-made timetable, so these tests don't move when the real one is refreshed.
const sched: Schedule = {
  generatedAt: "2026-11-20T00:00:00.000Z",
  origins: { "92": "Morristown" },
  destinations: { "105": "New York Penn Station" },
  coords: {},
  routes: { "7": { name: "Morris & Essex", short: "M&E", color: "00A94F" } },
  trips: [
    { route: "7", service: "WK", origin: "92", dest: "105", dep: "07:24:00", arr: "08:39:00", headsign: "NEW YORK", train: "6912" },
    { route: "7", service: "SUN", origin: "92", dest: "105", dep: "05:23:00", arr: "06:40:00", headsign: "NEW YORK", train: "6908" },
    // Leaves after midnight but belongs to the previous service day (GTFS 24:40).
    { route: "7", service: "WK", origin: "105", dest: "92", dep: "24:40:00", arr: "25:50:00", headsign: "DOVER", train: "6699", ends: true },
  ],
  calendar: {
    WK: ["20261201", "20261202"],
    SUN: ["20261101", "20270314", "20271107"],
  },
};

const first = (now: number, filter: "any" | "today" | "tomorrow" = "any", o = "92", d = "105") =>
  nextDepartures(o, d, now, 4, filter, undefined, sched)[0];

describe("nextDepartures", () => {
  it("places an ordinary weekday train at its timetable time", () => {
    // Wed 2 Dec 2026, 6:00 AM EST (UTC-5)
    const dep = first(utc(2026, 12, 2, 11));
    expect(dep.depTime).toBe("7:24 AM");
    expect(dep.depEpochMs).toBe(utc(2026, 12, 2, 12, 24));
    expect(dep.arrTime).toBe("8:39 AM");
    expect(dep.durationMin).toBe(75);
    expect(dep.train).toBe("6912");
  });

  it("is not an hour late on the spring-forward Sunday", () => {
    // Sun 14 Mar 2027: clocks jump 2 AM -> 3 AM. The 5:23 is at 5:23 EDT (UTC-4).
    const dep = first(utc(2027, 3, 14, 8)); // 4:00 AM EDT
    expect(dep.depTime).toBe("5:23 AM");
    expect(dep.depEpochMs).toBe(utc(2027, 3, 14, 9, 23));
  });

  it("is not an hour early on the fall-back Sundays", () => {
    // Sun 1 Nov 2026 and Sun 7 Nov 2027: the 5:23 is at 5:23 EST (UTC-5).
    expect(first(utc(2026, 11, 1, 9, 30)).depEpochMs).toBe(utc(2026, 11, 1, 10, 23));
    expect(first(utc(2027, 11, 7, 9, 30)).depTime).toBe("5:23 AM");
  });

  it("anchors the service day at noon minus 12h, not local midnight", () => {
    // Ordinary day: the two are the same instant.
    expect(serviceDayAnchor(2026, 12, 2)).toBe(utc(2026, 12, 2, 5));
    // Spring forward: local midnight is 05:00Z, but GTFS time zero is 04:00Z.
    expect(serviceDayAnchor(2027, 3, 14)).toBe(utc(2027, 3, 14, 4));
  });

  it("resolves an after-midnight trip onto the next calendar day", () => {
    const lateNight = utc(2026, 12, 2, 4); // Tue 1 Dec, 11:00 PM EST
    const dep = first(lateNight, "any", "105", "92");
    expect(dep.depEpochMs).toBe(utc(2026, 12, 2, 5, 40)); // Wed 12:40 AM
    expect(dep.depTime).toBe("12:40 AM");
    expect(dep.endsAtDest).toBe(true);
    // "today" (still Tuesday) excludes it; once it is Wednesday it is today's.
    expect(first(lateNight, "today", "105", "92")).toBeUndefined();
    expect(first(utc(2026, 12, 2, 5, 10), "today", "105", "92")?.train).toBe("6699");
  });

  it("never returns a train that has already left", () => {
    expect(first(utc(2026, 12, 2, 12, 25))).toBeUndefined(); // 7:25 AM, the 7:24 is gone
  });

  it("'tomorrow' only returns the next calendar day, with an earliest time", () => {
    const evening = utc(2026, 12, 2, 1); // Tue 1 Dec, 8:00 PM EST
    expect(first(evening, "tomorrow")?.depTime).toBe("7:24 AM");
    const tooEarly = nextDepartures("92", "105", evening, 4, "tomorrow", 8 * 60, sched);
    expect(tooEarly).toHaveLength(0); // nothing at or after 8:00 AM
  });
});

describe("scheduleStatus", () => {
  it("reports how much timetable is left", () => {
    const st = scheduleStatus(utc(2026, 12, 2, 12), sched);
    expect(st.validFrom).toBe("2026-11-01");
    expect(st.validThrough).toBe("2027-11-07");
    expect(st.expired).toBe(false);
    expect(st.daysLeft).toBe(340);
  });

  it("flags an expired timetable instead of looking like 'no trains'", () => {
    const st = scheduleStatus(utc(2027, 11, 25, 15), sched);
    expect(st.expired).toBe(true);
    expect(st.daysLeft).toBeLessThan(0);
  });

  it("flags a timetable that hasn't started yet", () => {
    expect(scheduleStatus(utc(2026, 10, 1, 15), sched).expired).toBe(true);
  });
});

describe("the bundled data/schedule.json", () => {
  const real = bundled as Schedule;
  const built = Date.parse(real.generatedAt);

  it("was valid, with a comfortable margin, on the day it was generated", () => {
    const st = scheduleStatus(built, real);
    expect(st.expired).toBe(false);
    expect(st.daysLeft).toBeGreaterThanOrEqual(14);
  });

  it("has trips for every board the app shows", () => {
    for (const [o, d] of [["92", "105"], ["18", "63"], ["105", "92"], ["63", "18"]]) {
      expect(real.trips.some((t) => t.origin === o && t.dest === d), `${o} -> ${d}`).toBe(true);
    }
    expect(real.trips.every((t) => t.train), "every trip has a train number").toBe(true);
  });
});
