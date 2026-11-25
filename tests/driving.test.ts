import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockNextCache, sharedCache, stubFetch, utc } from "./helpers";

vi.mock("next/cache", () => mockNextCache());

import {
  _resetForTests,
  driveTo,
  driveToAddress,
  inLiveTrafficHours,
  parseLiveHours,
  parseTypical,
} from "@/lib/driving";

const STATION = { lat: 40.797113, lon: -74.474086 };
const HOME = "1 Test Lane, Testville, NJ";

beforeEach(() => {
  delete process.env.HOME_ADDRESS;
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.DRIVE_TYPICAL_MIN;
  delete process.env.DRIVE_LIVE_HOURS;
  sharedCache.clear();
  _resetForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("configuration parsing", () => {
  it("reads typical minutes per destination", () => {
    const m = parseTypical("92=16, 18:10 ,commute = 15");
    expect([...m]).toEqual([["92", 16], ["18", 10], ["commute", 15]]);
    expect(parseTypical(undefined).size).toBe(0);
    expect(parseTypical("92=abc,18=-4,x").size).toBe(0);
  });
  it("reads the live-traffic hours, defaulting to 5–11", () => {
    expect(parseLiveHours("6-10")).toEqual([6, 10]);
    expect(parseLiveHours(undefined)).toEqual([5, 11]);
    expect(parseLiveHours("22-3")).toEqual([5, 11]);
  });
  it("asks for live traffic only in those New York hours", () => {
    expect(inLiveTrafficHours(utc(2026, 12, 2, 12))).toBe(true); // 7 AM EST
    expect(inLiveTrafficHours(utc(2026, 12, 2, 19))).toBe(false); // 2 PM EST
    expect(inLiveTrafficHours(utc(2026, 12, 2, 9, 59))).toBe(false); // 4:59 AM EST
    process.env.DRIVE_LIVE_HOURS = "13-15";
    expect(inLiveTrafficHours(utc(2026, 12, 2, 19))).toBe(true);
  });
});

describe("typical first", () => {
  it("works with no Google key at all", async () => {
    process.env.DRIVE_TYPICAL_MIN = "92=16";
    const calls = stubFetch(() => json({}));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 960, source: "typical" });
    expect(calls).toHaveLength(0);
  });
  it("returns null when nothing is configured", async () => {
    expect(await driveTo("92", STATION, true)).toBeNull();
    expect(await driveToAddress("commute", "Some School", false)).toBeNull();
  });
});

describe("live traffic", () => {
  beforeEach(() => {
    process.env.HOME_ADDRESS = HOME;
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    process.env.DRIVE_TYPICAL_MIN = "92=16,commute=15";
  });

  it("uses Google's answer when asked and it works", async () => {
    const calls = stubFetch(() => json({ routes: [{ duration: "1134s" }] }));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 1134, source: "live" });
    expect(calls[0].url).toContain("routes.googleapis.com");
    expect(JSON.parse(calls[0].body).origin).toEqual({ address: HOME });
  });

  it("doesn't call Google outside the hours it was asked for", async () => {
    const calls = stubFetch(() => json({ routes: [{ duration: "1134s" }] }));
    expect(await driveTo("92", STATION, false)).toEqual({ sec: 960, source: "typical" });
    expect(calls).toHaveLength(0);
  });

  it("asks Google once per destination per 10-minute slot, however many requests arrive", async () => {
    const calls = stubFetch(() => json({ routes: [{ duration: "900s" }] }));
    await Promise.all([driveTo("92", STATION, true), driveTo("92", STATION, true)]);
    await driveTo("92", STATION, true);
    _resetForTests(); // another serverless instance, same shared cache
    await driveTo("92", STATION, true);
    expect(calls).toHaveLength(1);
    await driveToAddress("commute", "Some School", true);
    expect(calls).toHaveLength(2);
  });

  it("falls back to the typical time when the key is dead — and doesn't keep retrying", async () => {
    const calls = stubFetch(() =>
      json({ error: { status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] } }, 400)
    );
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 960, source: "typical" });
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 960, source: "typical" });
    expect(calls).toHaveLength(1);
    expect(vi.mocked(console.warn).mock.calls.flat().join(" ")).toContain("API_KEY_INVALID");
  });

  it("never logs the key or the home address", async () => {
    stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    await driveTo("92", STATION, true);
    const logged = vi.mocked(console.warn).mock.calls.flat().join(" ");
    expect(logged).not.toContain("test-key");
    expect(logged).not.toContain("Test Lane");
  });

  it("ignores absurd durations", async () => {
    stubFetch(() => json({ routes: [{ duration: "0s" }] }));
    expect(await driveTo("92", STATION, true)).toEqual({ sec: 960, source: "typical" });
  });
});
