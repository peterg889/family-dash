import { NextResponse } from "next/server";
import {
  nextDepartures,
  STATION_NAMES,
  STATION_COORDS,
  SCHEDULE_GENERATED_AT,
  type DayFilter,
} from "@/lib/departures";
import {
  driveSecondsTo,
  driveSecondsToAddress,
  HOME_ADDRESS,
} from "@/lib/driving";

export const dynamic = "force-dynamic";

// Daily school run — drive time + ETA from home, with a Maps directions link.
const WILLOW = {
  name: "Willow School",
  address: "The Willow School, 1150 Pottersville Rd, Gladstone, NJ 07934",
};

type BoardDef = { origin: string; dest: string; short: string };

// Outbound (home -> city): the morning commute. "Penn" is NY Penn (105),
// "Hoboken" is 63.
const OUTBOUND: BoardDef[] = [
  { origin: "92", dest: "105", short: "Penn" }, // Morristown -> New York
  { origin: "18", dest: "105", short: "Penn" }, // Bernardsville -> New York
  { origin: "18", dest: "63", short: "Hoboken" }, // Bernardsville -> Hoboken
];

// Inbound (city -> home): the evening trip home. destShort is the suburb.
const INBOUND: BoardDef[] = [
  { origin: "105", dest: "92", short: "Morristown" }, // NY -> Morristown
  { origin: "105", dest: "18", short: "Bernardsville" }, // NY -> Bernardsville
  { origin: "63", dest: "18", short: "Bernardsville" }, // Hoboken -> Bernardsville
];

const TRAINS_PER_BOARD = 5;

// Leave home this many ms before (departure − drive time), as a safety margin.
const BUFFER_MS = 5 * 60_000;

// Window boundaries (NY hour): outbound today until 3 PM, inbound until 8 PM,
// then outbound for tomorrow morning.
const EVENING_FROM = 15; // 3 PM
const NEXT_MORNING_FROM = 20; // 8 PM
// When previewing tomorrow morning, skip trains before this time (minutes
// after midnight).
const MORNING_START_MIN = 6 * 60 + 30; // 6:30 AM

function nyHour(now: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(now));
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  return h === 24 ? 0 : h;
}

/** Pick which routes / direction / day to show based on the time of day. */
function pickMode(now: number): {
  mode: "morning" | "evening" | "next-morning";
  direction: "outbound" | "inbound";
  boards: BoardDef[];
  dayFilter: DayFilter;
  minNyMinutes?: number;
  showLeave: boolean;
  headline: string;
} {
  const h = nyHour(now);
  if (h < EVENING_FROM) {
    return {
      mode: "morning",
      direction: "outbound",
      boards: OUTBOUND,
      dayFilter: "today",
      showLeave: true,
      headline: "To NYC · today",
    };
  }
  if (h < NEXT_MORNING_FROM) {
    return {
      mode: "evening",
      direction: "inbound",
      boards: INBOUND,
      dayFilter: "today",
      showLeave: false,
      headline: "Heading home · tonight",
    };
  }
  return {
    mode: "next-morning",
    direction: "outbound",
    boards: OUTBOUND,
    dayFilter: "tomorrow",
    minNyMinutes: MORNING_START_MIN,
    showLeave: true,
    headline: "To NYC · tomorrow morning",
  };
}

export async function GET(req: Request) {
  // `?now=<epochMs>` overrides the clock for testing the time-of-day windows.
  const override = new URL(req.url).searchParams.get("now");
  const now = override ? Number(override) : Date.now();
  const {
    mode,
    direction,
    boards: boardDefs,
    dayFilter,
    minNyMinutes,
    showLeave,
    headline,
  } = pickMode(now);

  // Willow School drive (always shown) kicks off concurrently with station drives.
  const willowPromise = driveSecondsToAddress("willow", WILLOW.address, now);

  // Drive-to-station / leave-by only applies to outbound (you drive from home
  // to the departure station). Compute once per unique origin station.
  const driveByOrigin: Record<string, number | null> = {};
  if (showLeave) {
    const originIds = [...new Set(boardDefs.map((b) => b.origin))];
    await Promise.all(
      originIds.map(async (id) => {
        driveByOrigin[id] = await driveSecondsTo(id, STATION_COORDS[id], now);
      })
    );
  }

  const willowSec = await willowPromise;
  const commute = {
    name: WILLOW.name,
    driveMin: willowSec != null ? Math.round(willowSec / 60) : null,
    etaEpochMs: willowSec != null ? now + willowSec * 1000 : null,
    mapsUrl:
      "https://www.google.com/maps/dir/?api=1" +
      `&origin=${encodeURIComponent(HOME_ADDRESS)}` +
      `&destination=${encodeURIComponent(WILLOW.address)}` +
      "&travelmode=driving",
  };

  const boards = boardDefs.map(({ origin, dest, short }) => {
    const driveSec = showLeave ? driveByOrigin[origin] : null;
    const departures = nextDepartures(
      origin,
      dest,
      now,
      TRAINS_PER_BOARD,
      dayFilter,
      minNyMinutes
    ).map((d) => ({
      ...d,
      leaveByEpochMs:
        driveSec != null ? d.depEpochMs - driveSec * 1000 - BUFFER_MS : null,
    }));
    return {
      origin: STATION_NAMES[origin],
      dest: STATION_NAMES[dest],
      destShort: short,
      driveMin: driveSec != null ? Math.round(driveSec / 60) : null,
      departures,
    };
  });

  return NextResponse.json({
    now,
    generatedAt: SCHEDULE_GENERATED_AT,
    bufferMin: BUFFER_MS / 60_000,
    mode,
    direction,
    showLeave,
    headline,
    commute,
    boards,
  });
}
