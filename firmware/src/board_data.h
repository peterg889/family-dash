// firmware/src/board_data.h — parsed shape of the family-dash /api/departures
// response. Shared by board_api.cpp (fills it from the fetched JSON) and
// ui.cpp (renders it). Kept free of Arduino headers so the native preview can
// build ui.cpp with mock data.
#pragma once

#include <stdint.h>
#include <time.h>

struct DepView {
  time_t leaveEpoch;  // when to leave home (depart - drive - buffer)
  time_t depEpoch;    // train departs origin
  time_t arrEpoch;    // train arrives destination
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
