import { describe, expect, it } from "vitest";
import { evaluate } from "../scripts/health-check.mjs";

const NOW = Date.UTC(2026, 11, 2, 15, 0); // Wed 2 Dec 2026, 10:00 AM New York
const healthy = () => ({
  showLeave: true,
  status: {
    schedule: { expired: false, daysLeft: 120 },
    live: "ok",
    drive: "earlier",
    device: { id: "eink", lastSeenMs: NOW - 2 * 60_000 },
  },
  boards: [
    { driveMeasuredAtMs: NOW - 2 * 3600_000, departures: [{}] },
    { driveMeasuredAtMs: NOW - 2 * 3600_000, departures: [] },
  ],
});
const check = (edit: (b: ReturnType<typeof healthy>) => void, opts = {}) => {
  const b = healthy();
  edit(b);
  return evaluate(b, NOW, opts) as string[];
};

describe("health check", () => {
  it("is quiet when everything is fine", () => {
    expect(check(() => {})).toEqual([]);
  });
  it("speaks up for each thing a person would want to know", () => {
    expect(check((b) => (b.status.schedule.expired = true))[0]).toMatch(/timetable has expired/);
    expect(check((b) => (b.status.schedule.daysLeft = 3))[0]).toMatch(/runs out in 3 day/);
    expect(check((b) => (b.status.live = "down"))[0]).toMatch(/live status is unavailable/);
    expect(check((b) => (b.status.drive = "none"))[0]).toMatch(/no drive times/);
    expect(check((b) => b.boards.forEach((x) => (x.departures = [])))[0]).toMatch(/Every board is empty/);
    expect(check((b) => b.boards.forEach((x) => (x.driveMeasuredAtMs = NOW - 40 * 3600_000)))[0]).toMatch(
      /haven't been measured since/
    );
  });
  it("notices a sign that has gone quiet — but not one that was never seen", () => {
    expect(check((b) => (b.status.device.lastSeenMs = NOW - 50 * 60_000))[0]).toMatch(/hasn't checked in since Wed 9:10 AM/);
    expect(check((b) => (b.status.device.lastSeenMs = NOW - 20 * 60_000))).toEqual([]);
    expect(check((b) => ((b.status.device as { lastSeenMs: number | null }).lastSeenMs = null))).toEqual([]);
    expect(check((b) => (b.status.device.lastSeenMs = NOW - 50 * 60_000), { checkSign: false })).toEqual([]);
  });
  it("doesn't call 'no drive times' a problem in the evening view, which has none by design", () => {
    expect(check((b) => ((b.showLeave = false), (b.status.drive = "off")))).toEqual([]);
  });
  it("flags a reply that isn't a board at all", () => {
    expect(evaluate({ error: "nope" }, NOW)).toHaveLength(1);
  });
});
