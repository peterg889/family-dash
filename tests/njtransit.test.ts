import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { json, mockNextCache, sharedCache, stubFetch, utc } from "./helpers";

vi.mock("next/cache", () => mockNextCache());

import {
  _resetForTests,
  classify,
  fetchStationBoard,
  matchLiveStatus,
  parseNjtDate,
  toLiveTrain,
} from "@/lib/njtransit";

const board = (code = "MR") => ({
  STATION_2CHAR: code,
  ITEMS: [
    { SCHED_DEP_DATE: "25-Nov-2026 10:27:00 AM", DESTINATION: "New York", TRACK: "2", LINE: "Morristown Line", TRAIN_ID: "6632", STATUS: "in 2 Min", SEC_LATE: "-3" },
  ],
});
const INVALID_TOKEN = () => json({ errorMessage: "Invalid token." }, 500);
const logins = (calls: { url: string }[]) => calls.filter((c) => c.url.endsWith("/getToken")).length;
const dataCalls = (calls: { url: string }[]) => calls.filter((c) => !c.url.endsWith("/getToken")).length;

beforeEach(() => {
  process.env.NJT_API_USERNAME = "user";
  process.env.NJT_API_PASSWORD = "pass";
  sharedCache.clear();
  _resetForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseNjtDate", () => {
  it("reads NJ Transit's New York wall-clock timestamps", () => {
    expect(parseNjtDate("25-Nov-2026 10:23:00 AM")).toBe(utc(2026, 11, 25, 15, 23)); // EST
    expect(parseNjtDate("29-Jun-2026 11:01:00 PM")).toBe(utc(2026, 6, 30, 3, 1)); // EDT
    expect(parseNjtDate("01-Jan-2027 12:05:00 AM")).toBe(utc(2027, 1, 1, 5, 5));
    expect(parseNjtDate("01-Jan-2027 12:05:00 PM")).toBe(utc(2027, 1, 1, 17, 5));
  });
  it("returns null for blanks and junk", () => {
    expect(parseNjtDate("")).toBeNull();
    expect(parseNjtDate(undefined)).toBeNull();
    expect(parseNjtDate("soon")).toBeNull();
  });
});

describe("classify", () => {
  const t = (over: Record<string, unknown>) =>
    classify(toLiveTrain({ TRAIN_ID: "1", STATUS: " ", SEC_LATE: "0", TRACK: "", ...over }));

  it("treats a blank status with no delay as on time", () => {
    expect(t({}).state).toBe("on-time");
  });
  it("treats SEC_LATE -60 as 'no estimate yet', not early", () => {
    expect(t({ SEC_LATE: "-60" })).toMatchObject({ state: "on-time", delayMin: 0 });
  });
  it("reports delays in minutes", () => {
    expect(t({ SEC_LATE: "380" })).toMatchObject({ state: "delayed", delayMin: 6 });
  });
  it("treats 'DELAYED' with no estimate as delayed", () => {
    expect(t({ STATUS: "DELAYED" })).toMatchObject({ state: "delayed", delayMin: 0 });
  });
  it("recognizes cancellations and boarding", () => {
    expect(t({ STATUS: "CANCELLED", SEC_LATE: "600" }).state).toBe("cancelled");
    expect(t({ STATUS: "All Aboard" }).state).toBe("boarding");
  });
  it("hides the Gladstone branch's 'Single' track", () => {
    expect(t({ TRACK: "Single" }).track).toBeNull();
    expect(t({ TRACK: "3" }).track).toBe("3");
  });
});

describe("matchLiveStatus", () => {
  const trains = [
    toLiveTrain({ SCHED_DEP_DATE: "25-Nov-2026 05:17:00 PM", TRAIN_ID: "6431", TRACK: "9", STATUS: "BOARDING" }),
    toLiveTrain({ SCHED_DEP_DATE: "25-Nov-2026 05:17:00 PM", TRAIN_ID: "3871", TRACK: "4", STATUS: " " }),
  ];
  const at517 = utc(2026, 11, 25, 22, 17);
  it("joins by train number where several trains share a minute", () => {
    expect(matchLiveStatus(trains, at517, "6431")?.track).toBe("9");
    expect(matchLiveStatus(trains, at517, "03871")?.track).toBe("4"); // zero-padded in the timetable
  });
  it("ignores a same-numbered train far away in time", () => {
    expect(matchLiveStatus(trains, at517 + 6 * 3600_000, "6431")).toBeNull();
  });
});

describe("fetchStationBoard — the 5-logins-a-day budget", () => {
  it("logs in once and reuses the answer within its cache window", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    expect(await fetchStationBoard("MR")).toHaveLength(1);
    expect(await fetchStationBoard("MR")).toHaveLength(1);
    expect(logins(calls)).toBe(1);
    expect(dataCalls(calls)).toBe(1);
  });

  it("does NOT log in again when a data call times out or errors", async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith("/getToken")) return json({ Authenticated: "True", UserToken: "t0" });
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(await fetchStationBoard("BV")).toBeNull();
    expect(logins(calls)).toBe(1);
  });

  it("does NOT log in again on a plain server error", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json({ errorMessage: "Server busy" }, 503)));
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(logins(calls)).toBe(1);
  });

  it("backs off after a failure instead of hammering the API", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json({}, 502)));
    await fetchStationBoard("MR");
    await fetchStationBoard("MR");
    await fetchStationBoard("MR");
    expect(dataCalls(calls)).toBe(1);
  });

  it("logs in again exactly once when the API says the token is invalid", async () => {
    let n = 0;
    const calls = stubFetch((url, body) => {
      if (url.endsWith("/getToken")) return json({ Authenticated: "True", UserToken: `t${n++}` });
      return body.includes("token=t0") ? INVALID_TOKEN() : json(board());
    });
    expect(await fetchStationBoard("MR")).toHaveLength(1);
    expect(logins(calls)).toBe(2);
    // ...and the replacement sticks for later calls.
    expect(await fetchStationBoard("BV")).not.toBeNull();
    expect(logins(calls)).toBe(2);
  });

  it("gives up for the day after three rejected tokens", async () => {
    let n = 0;
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: `t${n++}` }) : INVALID_TOKEN()));
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(await fetchStationBoard("BV")).toBeNull();
    expect(await fetchStationBoard("NY")).toBeNull();
    expect(logins(calls)).toBe(3);
  });

  it("shares the day's token across serverless instances", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    await fetchStationBoard("MR");
    _resetForTests(); // a cold start: in-memory state gone, shared cache intact
    await fetchStationBoard("MR");
    expect(logins(calls)).toBe(1);
    expect(dataCalls(calls)).toBe(2);
  });

  it("stops trying to log in for a while after a failed login", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "False" }) : json(board())));
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(await fetchStationBoard("BV")).toBeNull();
    expect(logins(calls)).toBe(1);
    expect(dataCalls(calls)).toBe(0);
  });

  it("makes no calls at all without credentials", async () => {
    delete process.env.NJT_API_USERNAME;
    const calls = stubFetch(() => json(board()));
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns an empty board (not a failure) when the station has nothing listed", async () => {
    stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json({ STATION_2CHAR: "ZZ", ITEMS: null })));
    expect(await fetchStationBoard("ZZ")).toEqual([]);
  });
});
