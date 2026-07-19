// firmware/src/board_data.h — parsed shape of the family-dash /api/departures
// response. Shared by board_api.cpp (fills it from the fetched JSON) and
// ui.cpp (renders it). Kept free of Arduino headers so the native preview can
// build ui.cpp with mock data.
#pragma once

#include <stdint.h>
#include <time.h>

// Live DepartureVision status. LIVE_NONE = no live data for this train (e.g.
// next-morning preview, or the upstream API was unreachable); LIVE_ON_TIME
// covers both "on-time" and "unknown" — tracked, nothing to flag.
enum LiveState : uint8_t {
  LIVE_NONE = 0,
  LIVE_ON_TIME,
  LIVE_DELAYED,
  LIVE_CANCELLED,
  LIVE_BOARDING,
};

struct DepView {
  time_t leaveEpoch;  // when to leave home (depart - drive - buffer);
                      // 0 on evening (city->home) boards, which have no
                      // drive leg — count down to depEpoch instead
  time_t depEpoch;    // train departs origin
  time_t arrEpoch;    // train arrives destination
  uint8_t live;       // LiveState
  int16_t delayMin;   // minutes late when LIVE_DELAYED
  char track[8];      // assigned track, "" until known
};

struct BoardView {
  char origin[28];     // "Morristown"
  char destShort[16];  // "Penn" / "Hoboken"
  int driveMin;        // traffic-aware drive home->origin station
  DepView deps[6];     // as many as the API sends (TRAINS_PER_BOARD, now 5)
  int nDeps;
};

struct BoardData {
  char headline[48];  // e.g. "To NYC · today"
  int bufferMin;
  BoardView boards[6];
  int nBoards;
  bool ok;            // last fetch parsed successfully
  time_t fetchedAt;   // device clock at last good fetch (0 = never)
};
