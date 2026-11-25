import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockVercelFunctions, runtimeCache, stubFetch, utc } from "./helpers";

vi.mock("@vercel/functions", () => mockVercelFunctions());

import {
  _resetForTests,
  driveTo,
  driveToAddress,
  inLiveTrafficHours,
  parseLiveHours,
} from "@/lib/driving";

const STATION = { lat: 40.797113, lon: -74.474086 };
const HOME = "1 Test Lane, Testville, NJ";
const MIN = 60_000;

// Wed 2 Dec 2026 (EST, UTC-5).
const at = (h: number, mi = 0) => utc(2026, 12, 2, h + 5, mi);
const google = (seconds: number) => () => json({ routes: [{ duration: `${seconds}s` }] });
const coldStart = () => _resetForTests(); // a new server instance; the shared cache survives

beforeEach(() => {
  process.env.HOME_ADDRESS = HOME;
  process.env.GOOGLE_MAPS_API_KEY = "test-key";
  delete process.env.DRIVE_LIVE_HOURS;
  runtimeCache.clear();
  _resetForTests();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("live hours", () => {
  it("default to 6–8 AM New York", () => {
    expect(parseLiveHours(undefined)).toEqual([6, 8]);
    expect(inLiveTrafficHours(at(5, 59))).toBe(false);
    expect(inLiveTrafficHours(at(6, 0))).toBe(true);
    expect(inLiveTrafficHours(at(7, 59))).toBe(true);
    expect(inLiveTrafficHours(at(8, 0))).toBe(false);
  });
  it("can be changed", () => {
    expect(parseLiveHours("5-10")).toEqual([5, 10]);
    expect(parseLiveHours("22-3")).toEqual([6, 8]); // nonsense falls back to the default
    process.env.DRIVE_LIVE_HOURS = "13-15";
    expect(inLiveTrafficHours(at(14))).toBe(true);
  });
});

describe("during the live hours", () => {
  it("measures with Google and reports it as live", async () => {
    vi.setSystemTime(at(7, 0));
    const calls = stubFetch(google(1134));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 1134, source: "live", measuredAt: at(7, 0) });
    expect(calls[0].url).toContain("routes.googleapis.com");
    expect(JSON.parse(calls[0].body)).toMatchObject({
      origin: { address: HOME },
      routingPreference: "TRAFFIC_AWARE",
    });
  });

  it("re-measures about every 5 minutes — not on every request", async () => {
    const calls = stubFetch(google(900));
    for (let m = 0; m < 120; m++) {
      vi.setSystemTime(at(6, m)); // a request every minute from 6:00 to 7:59
      await driveTo("92", STATION, true);
    }
    expect(calls).toHaveLength(24); // 2 hours of 5-minute slots
  });

  it("makes one call per slot across concurrent requests and server instances", async () => {
    vi.setSystemTime(at(7, 0));
    const calls = stubFetch(google(900));
    await Promise.all([driveTo("92", STATION, true), driveTo("92", STATION, true)]);
    coldStart();
    await driveTo("92", STATION, true);
    expect(calls).toHaveLength(1);
    await driveToAddress("commute", "Some School", true); // a different destination
    expect(calls).toHaveLength(2);
  });

  it("keeps showing the last measurement, marked earlier, if Google stops answering", async () => {
    vi.setSystemTime(at(7, 0));
    let calls = stubFetch(google(1000));
    await driveTo("92", STATION, true);
    vi.setSystemTime(at(7, 20));
    calls = stubFetch(() => json({ error: { status: "UNAVAILABLE" } }, 503));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 1000, source: "earlier", measuredAt: at(7, 0) });
    // ...and doesn't hammer Google: one attempt per 5-minute slot.
    await driveTo("92", STATION, true);
    coldStart();
    await driveTo("92", STATION, true);
    expect(calls).toHaveLength(1);
  });
});

describe("outside the live hours", () => {
  it("shows this morning's last measurement without calling Google", async () => {
    vi.setSystemTime(at(7, 55));
    stubFetch(google(1080));
    await driveTo("92", STATION, true);

    const calls = stubFetch(google(600));
    for (const [h, m] of [[8, 5], [9, 30], [14, 0], [21, 0], [29, 59]]) {
      vi.setSystemTime(at(h, m)); // through 5:59 the next morning
      expect(await driveTo("92", STATION, true)).toEqual({ sec: 1080, source: "earlier", measuredAt: at(7, 55) });
    }
    expect(calls).toHaveLength(0);
    // 6:00 the next morning: live again.
    vi.setSystemTime(at(30, 0));
    expect(await driveTo("92", STATION, true)).toMatchObject({ sec: 600, source: "live" });
  });

  it("takes one measurement if there is none yet (first deploy, or a missed morning)", async () => {
    vi.setSystemTime(at(13, 0));
    const calls = stubFetch(google(840));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 840, source: "live", measuredAt: at(13, 0) });
    vi.setSystemTime(at(13, 30));
    expect(await driveTo("92", STATION, true)).toMatchObject({ sec: 840, source: "earlier" });
    expect(calls).toHaveLength(1);
  });

  it("refreshes a measurement that is more than a day old", async () => {
    vi.setSystemTime(at(7, 55));
    stubFetch(google(1080));
    await driveTo("92", STATION, true);
    vi.setSystemTime(at(7 + 48, 0) + 4 * 3600_000); // two days later, mid-day
    const calls = stubFetch(google(700));
    expect(await driveTo("92", STATION, true)).toMatchObject({ sec: 700, source: "live" });
    expect(calls).toHaveLength(1);
  });
});

describe("when Google can't be used", () => {
  it("there is no drive time — nothing is guessed", async () => {
    vi.setSystemTime(at(7, 0));
    const calls = stubFetch(() =>
      json({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, 400)
    );
    expect(await driveTo("92", STATION, true)).toBeNull();
    expect(await driveTo("92", STATION, true)).toBeNull();
    expect(calls).toHaveLength(1); // one attempt per slot, even when failing
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("API_KEY_INVALID");
  });

  it("makes no calls without a key or a home address", async () => {
    vi.setSystemTime(at(7, 0));
    const calls = stubFetch(google(900));
    delete process.env.GOOGLE_MAPS_API_KEY;
    expect(await driveTo("92", STATION, true)).toBeNull();
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    delete process.env.HOME_ADDRESS;
    expect(await driveTo("92", STATION, true)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("a test clock never calls Google, but can still show the last measurement", async () => {
    vi.setSystemTime(at(7, 0));
    const calls = stubFetch(google(900));
    expect(await driveTo("92", STATION, false)).toBeNull();
    await driveTo("92", STATION, true);
    vi.setSystemTime(at(7, 30));
    expect(await driveTo("92", STATION, false)).toMatchObject({ sec: 900, source: "earlier" });
    expect(calls).toHaveLength(1);
  });

  it("never logs the key or the home address", async () => {
    vi.setSystemTime(at(7, 0));
    stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await driveTo("92", STATION, true);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain("Test Lane");
  });

  it("ignores absurd durations", async () => {
    vi.setSystemTime(at(7, 0));
    stubFetch(google(0));
    expect(await driveTo("92", STATION, true)).toBeNull();
  });
});
