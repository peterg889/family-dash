import { NextResponse } from "next/server";
import {
  nextDepartures,
  STATION_NAMES,
  SCHEDULE_GENERATED_AT,
} from "@/lib/departures";

export const dynamic = "force-dynamic";

// The four boards we show: each origin paired with each destination.
const BOARDS: { origin: string; dest: string; note?: string }[] = [
  { origin: "92", dest: "105" }, // Morristown -> New York
  { origin: "92", dest: "63" }, // Morristown -> Hoboken
  {
    origin: "18",
    dest: "105", // Bernardsville -> New York
    note: "Few one-seat rides — most NY trips transfer at Summit.",
  },
  { origin: "18", dest: "63" }, // Bernardsville -> Hoboken
];

export async function GET() {
  const now = Date.now();
  const boards = BOARDS.map(({ origin, dest, note }) => ({
    origin: STATION_NAMES[origin],
    dest: STATION_NAMES[dest],
    note,
    departures: nextDepartures(origin, dest, now, 4),
  }));

  return NextResponse.json({
    now,
    generatedAt: SCHEDULE_GENERATED_AT,
    boards,
  });
}
