// firmware/src/departures.h
//
// On-device port of lib/departures.ts. Computes the next scheduled
// departures for a board (origin -> dest) from the baked-in GTFS-derived
// schedule (schedule_data.h), against the current wall-clock time.
//
// Requires the process/newlib timezone to be America/New_York, i.e.
//   setenv("TZ", "EST5EDT,M3.2.0,M11.1.0", 1); tzset();
// so that mktime()/localtime_r() resolve NY local time with correct DST.
#pragma once

#include <stdint.h>
#include <time.h>

struct Departure {
  time_t depEpoch;    // departure instant (unix seconds)
  time_t arrEpoch;    // arrival instant at destination
  uint8_t route;      // index into SCHED_ROUTE
  uint8_t headsign;   // index into SCHED_HEADSIGN
  int durationMin;    // rounded minutes, dep -> arr
};

// Next up to `limit` departures (>= now) for board index `boardIdx`,
// written in ascending departure order into `out` (capacity >= limit,
// and limit <= DEP_MAX). Returns the number written.
#define DEP_MAX 8
int departures_for_board(int boardIdx, time_t now, Departure* out, int limit);
