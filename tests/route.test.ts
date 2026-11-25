import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  json,
  mockNextCache,
  mockVercelFunctions,
  runtimeCache,
  sharedCache,
  stubFetch,
} from "./helpers";

vi.mock("next/cache", () => mockNextCache());
vi.mock("@vercel/functions", () => mockVercelFunctions());

import bundled from "@/data/schedule.json";
import { GET } from "@/app/api/departures/route";
import { nyWallToEpoch, nyDateParts, type Schedule } from "@/lib/departures";
import { _resetForTests as resetNjt } from "@/lib/njtransit";
import { _resetForTests as resetDrive } from "@/lib/driving";

const HOME = "1 Test Lane, Testville, NJ 00000";

// A day safely inside whatever timetable is bundled right now: three days after
// it was generated. `at(h)` is that day at hour h, New York time.
const base = nyDateParts(Date.parse((bundled as Schedule).generatedAt) + 3 * 86_400_000);
const at = (h: number, mi = 0) => nyWallToEpoch(base.y, base.mo, base.d, h, mi);

const call = async (query = "") => {
  const res = await GET(new Request(`https://example.test/api/departures${query}`));
  return { res, body: await res.json() };
};

// Pretend Google measured these drive times a little while ago.
const seedDriveTimes = (minutes: Record<string, number>, ageMs = 30 * 60_000) => {
  for (const [key, min] of Object.entries(minutes)) {
    runtimeCache.set(`drive$last:${key}`, {
      value: { sec: min * 60, at: Date.now() - ageMs },
      expires: Infinity,
    });
  }
};

beforeEach(() => {
  process.env.HOME_ADDRESS = HOME;
  delete process.env.GOOGLE_MAPS_API_KEY;
  runtimeCache.clear();
  seedDriveTimes({ "92": 16, "18": 10, commute: 15 });
  delete process.env.NJT_API_USERNAME;
  delete process.env.NJT_API_PASSWORD;
  sharedCache.clear();
  resetNjt();
  resetDrive();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GET /api/departures", () => {
  it("never reveals the home address", async () => {
    const res = await GET(new Request(`https://example.test/api/departures?now=${at(7)}`));
    const text = await res.text();
    expect(text).not.toContain("Test Lane");
    expect(text).not.toContain(encodeURIComponent("Test Lane"));
    expect(JSON.parse(text).commute.mapsUrl).not.toContain("origin=");
  });

  it("morning: outbound boards with a leave-by from Google's last measurement", async () => {
    const { body } = await call(`?now=${at(7)}`);
    expect(body).toMatchObject({ mode: "morning", showLeave: true, direction: "outbound" });
    expect(body.status).toMatchObject({ live: "off", drive: "earlier", schedule: { expired: false } });
    const mr = body.boards[0];
    expect(mr).toMatchObject({ origin: "Morristown", destShort: "Penn", driveMin: 16, driveSource: "earlier" });
    expect(mr.driveMeasuredAtMs).toBeLessThan(Date.now());
    expect(mr.departures.length).toBeGreaterThan(0);
    const d = mr.departures[0];
    expect(d.leaveByEpochMs).toBe(d.depEpochMs - 16 * 60_000 - 5 * 60_000);
    expect(d.source).toBe("schedule");
  });

  it("evening: inbound boards, no leave-by", async () => {
    const { body } = await call(`?now=${at(17)}`);
    expect(body).toMatchObject({ mode: "evening", showLeave: false, direction: "inbound" });
    expect(body.status.drive).toBe("off");
    expect(body.boards[0]).toMatchObject({ origin: "New York Penn Station", destShort: "Morristown", driveMin: null });
    expect(body.boards[0].departures[0].leaveByEpochMs).toBeNull();
  });

  it("late evening: tomorrow morning's trains, none before 6:30", async () => {
    const { body } = await call(`?now=${at(21)}`);
    expect(body.mode).toBe("next-morning");
    const first = body.boards[0].departures[0];
    expect(first.depEpochMs).toBeGreaterThanOrEqual(at(24 + 6, 30));
    expect(first.depEpochMs).toBeLessThan(at(48));
  });

  it("says the timetable is out of date instead of returning a quiet empty board", async () => {
    const { body } = await call(`?now=${at(7) + 400 * 86_400_000}`);
    expect(body.status.schedule.expired).toBe(true);
    expect(body.boards.every((b: { departures: unknown[] }) => b.departures.length === 0)).toBe(true);
  });

  it("reports missing drive times rather than guessing or pretending it's evening", async () => {
    runtimeCache.clear(); // Google has never answered
    const { body } = await call(`?now=${at(7)}`);
    expect(body.showLeave).toBe(true);
    expect(body.status.drive).toBe("none");
    expect(body.boards[0].departures[0].leaveByEpochMs).toBeNull();
  });

  it("a test clock (?now=) is never cached and never calls NJ Transit or Google", async () => {
    process.env.NJT_API_USERNAME = "u";
    process.env.NJT_API_PASSWORD = "p";
    process.env.GOOGLE_MAPS_API_KEY = "k";
    const calls = stubFetch(() => json({}));
    const { res, body } = await call(`?now=${at(7)}`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body.status.live).toBe("off");
    expect(calls).toHaveLength(0);
  });

  it("rejects a nonsense clock", async () => {
    const { res } = await call("?now=banana");
    expect(res.status).toBe(400);
  });

  it("real requests are cacheable at the edge for a few seconds", async () => {
    const { res, body } = await call();
    expect(res.headers.get("cache-control")).toContain("s-maxage=15");
    expect(Math.abs(body.now - Date.now())).toBeLessThan(5000);
  });

  it("answers from the timetable, flagged, when NJ Transit's live feed is down", async () => {
    process.env.NJT_API_USERNAME = "u";
    process.env.NJT_API_PASSWORD = "p";
    stubFetch((url) => {
      if (url.endsWith("/getToken")) return json({ Authenticated: "True", UserToken: "t" });
      throw new DOMException("timed out", "TimeoutError");
    });
    const { body } = await call();
    // Live status only applies to today's boards (before 8 PM New York).
    if (body.mode !== "next-morning") expect(body.status.live).toBe("down");
    expect(Array.isArray(body.boards)).toBe(true);
  });
});
