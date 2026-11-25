/**
 * The contract between the server and the E-Ink sign.
 *
 * The sign's firmware reads a fixed set of fields from /api/departures
 * (listed in firmware/api-fields.json, which the firmware build owns). This
 * test builds the exact response the sign asks for — from real captured NJ
 * Transit boards — and checks that every one of those fields is there, and that
 * the committed sample (tests/fixtures/api-outbound-sample.json) still has the
 * same shape. CI then feeds that sample through the firmware's real parser and
 * renderer on the build machine (tools/contract/check.sh).
 *
 * If the response shape changes on purpose: `npm run contract:update`, look at
 * the diff, and make sure the firmware still reads what it needs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { json, mockVercelFunctions, runtimeCache, stubFetch } from "./helpers";

vi.mock("@vercel/functions", () => mockVercelFunctions());

import { GET } from "@/app/api/departures/route";
import { parseNjtDate, _resetForTests as resetNjt } from "@/lib/njtransit";
import { _resetForTests as resetDrive } from "@/lib/driving";
import mrRaw from "./fixtures/live-board-MR-2026-11-25.json";
import bvRaw from "./fixtures/live-board-BV-2026-11-25.json";

const SAMPLE = "tests/fixtures/api-outbound-sample.json";
const FIELDS = "firmware/api-fields.json";
// The moment the fixtures were captured: Wed 25 Nov 2026, 10:24 AM New York.
const NOW = parseNjtDate("25-Nov-2026 10:24:00 AM")!;

/** Every key path in a value, arrays written as `[]`: "boards[].departures[].depEpochMs". */
function paths(v: unknown, prefix = "", out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) {
    out.add(`${prefix}[]`);
    for (const el of v) paths(el, `${prefix}[]`, out);
  } else if (v && typeof v === "object") {
    for (const [k, child] of Object.entries(v)) {
      const p = prefix ? `${prefix}.${k}` : k;
      out.add(p);
      paths(child, p, out);
    }
  }
  return out;
}

let body: Record<string, unknown>;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(console, "info").mockImplementation(() => {});
  process.env.NJT_API_USERNAME = "u";
  process.env.NJT_API_PASSWORD = "p";
  process.env.HOME_ADDRESS = "1 Test Lane, Testville, NJ";
  delete process.env.GOOGLE_MAPS_API_KEY;
  runtimeCache.clear();
  resetNjt();
  resetDrive();
  // Google measured these two hours ago (shown as "earlier").
  process.env.COMMUTE_NAME = "School";
  process.env.COMMUTE_ADDRESS = "9 Example School Rd, Testville, NJ";
  for (const [key, min] of Object.entries({ "92": 19, "18": 10, commute: 17 })) {
    runtimeCache.set(`drive$last:${key}`, { value: { sec: min * 60, at: NOW - 2 * 3600_000 }, expires: Infinity });
  }
  stubFetch((url, reqBody) => {
    if (url.endsWith("/getToken")) return json({ Authenticated: "True", UserToken: "t" });
    if (reqBody.includes("station=MR")) {
      return json({
        ...mrRaw,
        STATIONMSGS: [{ MSG_TEXT: "M&E trains are subject to 20-minute delays due to signal problems near Summit." }],
      });
    }
    if (reqBody.includes("station=BV")) return json(bvRaw);
    return json({ STATION_2CHAR: "??", ITEMS: [] });
  });
  const res = await GET(
    new Request("https://example.test/api/departures?direction=outbound&limit=12&device=eink")
  );
  body = await res.json();
  if (process.env.UPDATE_CONTRACT_SAMPLE) writeFileSync(SAMPLE, JSON.stringify(body, null, 1) + "\n");
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("what the sign is sent", () => {
  it("is a live board to the city with drive times, trains and an alert", () => {
    expect(body).toMatchObject({ mode: "morning", direction: "outbound", showLeave: true });
    expect(body.status).toMatchObject({ live: "ok", drive: "earlier", schedule: { expired: false } });
    const boards = body.boards as { departures: unknown[]; driveMin: number }[];
    expect(boards[0].driveMin).toBe(19);
    expect(boards[0].departures.length).toBeGreaterThanOrEqual(9); // more than the web page's 5
    expect(body.alerts).toEqual([
      { text: "M&E trains are subject to 20-minute delays due to signal problems near Summit.", urgent: true },
    ]);
  });

  it("contains every field the firmware reads", () => {
    expect(existsSync(FIELDS), `${FIELDS} is missing`).toBe(true);
    const have = paths(body);
    const missing = (JSON.parse(readFileSync(FIELDS, "utf8")) as string[]).filter((f) => !have.has(f));
    expect(missing, "fields the firmware reads but the server no longer sends").toEqual([]);
  });

  it("still has the shape of the committed sample the firmware is tested against", () => {
    expect(existsSync(SAMPLE), `${SAMPLE} is missing — run: npm run contract:update`).toBe(true);
    const sample = JSON.parse(readFileSync(SAMPLE, "utf8"));
    expect([...paths(body)].sort()).toEqual([...paths(sample)].sort());
  });
});
