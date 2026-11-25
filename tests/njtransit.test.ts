import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  json,
  mockVercelFunctions,
  runtimeCache,
  runtimeCacheState,
  stubFetch,
  utc,
} from "./helpers";

vi.mock("@vercel/functions", () => mockVercelFunctions());

import {
  _resetForTests,
  classify,
  fetchStationBoard,
  matchLiveStatus,
  parseNjtDate,
  alertAffectsTrains,
  parseStationMessages,
  stationAlerts,
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
  runtimeCache.clear();
  runtimeCacheState.broken = false;
  _resetForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
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

describe("station messages (service alerts)", () => {
  it("come back as plain text, without markup or duplicates", () => {
    const msgs = parseStationMessages({
      STATION_2CHAR: "MR",
      STATIONMSGS: [
        { MSG_TYPE: "banner", MSG_TEXT: "<b>M&amp;E trains</b> are subject to&nbsp;20-minute delays   due to signal problems." },
        { MSG_TEXT: "<b>M&amp;E trains</b> are subject to&nbsp;20-minute delays due to signal problems." },
        "Elevator at Morristown is out of service.",
        { MSG_TEXT: "   " },
      ],
    });
    expect(msgs).toEqual([
      "M&E trains are subject to 20-minute delays due to signal problems.",
      "Elevator at Morristown is out of service.",
    ]);
  });
  it("are empty when NJ Transit has nothing to say, and bounded when it has a lot", () => {
    expect(parseStationMessages({ STATION_2CHAR: "MR", STATIONMSGS: [] })).toEqual([]);
    expect(parseStationMessages({ STATION_2CHAR: "MR" })).toEqual([]);
    expect(parseStationMessages(null)).toEqual([]);
    const many = parseStationMessages({ STATIONMSGS: Array.from({ length: 9 }, (_, i) => `Message ${i} ${"x".repeat(400)}`) });
    expect(many).toHaveLength(3);
    expect(many[0].length).toBeLessThanOrEqual(240);
  });
  it("are marked urgent only when they say trains are affected", () => {
    for (const t of [
      "M&E trains are subject to 20-minute delays due to signal problems.",
      "Train 6632 is cancelled.",
      "Gladstone Branch service is suspended in both directions.",
      "Morris & Essex trains are running late following an earlier disabled train.",
      "There is no rail service between Summit and Hoboken.",
    ]) expect(alertAffectsTrains(t), t).toBe(true);
    for (const t of [
      // the real advisory that was up on 25 Nov 2026
      "NJ TRANSIT is tracking a storm system bringing periods of heavy rain and gusty winds to New Jersey Thursday and into Friday. NJ TRANSIT rail tickets and passes will be cross honored by NJ TRANSIT Bus on Thursday, November 26.",
      "The elevator at Morristown is out of service.",
      "Trains are operating on a holiday schedule on Thursday.",
    ]) expect(alertAffectsTrains(t), t).toBe(false);
  });

  it("ride along with the board fetch — no extra call", async () => {
    const calls = stubFetch((url) =>
      url.endsWith("/getToken")
        ? json({ Authenticated: "True", UserToken: "t0" })
        : json({ ...board(), STATIONMSGS: [{ MSG_TEXT: "Trains are running on a holiday schedule." }] })
    );
    await fetchStationBoard("MR", "full");
    expect(stationAlerts(["MR", "BV"])).toEqual(["Trains are running on a holiday schedule."]);
    expect(dataCalls(calls)).toBe(1);
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

  it("shares one token across server instances and deployments", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    await fetchStationBoard("MR");
    _resetForTests(); // a cold start or a new deployment: memory gone, shared cache intact
    await fetchStationBoard("BV");
    expect(logins(calls)).toBe(1);
    expect(dataCalls(calls)).toBe(2);
  });

  it("shares a freshly fetched board across instances — one upstream call, not one each", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    expect(await fetchStationBoard("MR", "full")).toHaveLength(1);
    for (let i = 0; i < 5; i++) {
      _resetForTests(); // five more instances, moments later
      expect(await fetchStationBoard("MR", "full")).toHaveLength(1);
    }
    expect(dataCalls(calls)).toBe(1);
  });

  it("fetches a board again once it is 45 seconds old", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc(2026, 12, 2, 12));
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    await fetchStationBoard("MR");
    vi.setSystemTime(utc(2026, 12, 2, 12) + 30_000);
    await fetchStationBoard("MR");
    expect(dataCalls(calls)).toBe(1);
    vi.setSystemTime(utc(2026, 12, 2, 12) + 50_000);
    _resetForTests();
    await fetchStationBoard("MR");
    expect(dataCalls(calls)).toBe(2);
  });

  it("keeps using the same token on later days — no daily login", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc(2026, 12, 2, 12));
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    await fetchStationBoard("MR");
    for (const day of [3, 4, 9]) {
      vi.setSystemTime(utc(2026, 12, day, 12));
      _resetForTests();
      expect(await fetchStationBoard("MR")).toHaveLength(1);
    }
    expect(logins(calls)).toBe(1);
  });

  it("gets a fresh budget the next day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(utc(2026, 12, 2, 12));
    let n = 0;
    let accept = false;
    const calls = stubFetch((url) => {
      if (url.endsWith("/getToken")) return json({ Authenticated: "True", UserToken: `t${n++}` });
      return accept ? json(board()) : INVALID_TOKEN();
    });
    expect(await fetchStationBoard("MR")).toBeNull(); // burns today's three
    expect(logins(calls)).toBe(3);
    vi.setSystemTime(utc(2026, 12, 3, 12));
    _resetForTests();
    accept = true;
    expect(await fetchStationBoard("MR")).toHaveLength(1);
    expect(logins(calls)).toBe(4);
  });

  it("does not log in at all if the shared cache is unavailable", async () => {
    runtimeCacheState.broken = true;
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
    expect(await fetchStationBoard("MR")).toBeNull();
    _resetForTests();
    expect(await fetchStationBoard("BV")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("stops trying to log in for a while after a failed login", async () => {
    const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "False" }) : json(board())));
    expect(await fetchStationBoard("MR")).toBeNull();
    expect(await fetchStationBoard("BV")).toBeNull();
    expect(logins(calls)).toBe(1);
    expect(dataCalls(calls)).toBe(0);
  });

  it("does not log in on a deployed instance that lacks the shared cache", async () => {
    // On Vercel the library would silently fall back to per-instance memory —
    // and every cold start would log in. Refuse instead.
    process.env.VERCEL_ENV = "production";
    try {
      const calls = stubFetch((url) => (url.endsWith("/getToken") ? json({ Authenticated: "True", UserToken: "t0" }) : json(board())));
      expect(await fetchStationBoard("MR")).toBeNull();
      expect(calls).toHaveLength(0);
    } finally {
      delete process.env.VERCEL_ENV;
    }
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
