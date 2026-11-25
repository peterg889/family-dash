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
  LIVE_DELAYED,  // delayMin == 0 means "delayed, by an unknown amount"
  LIVE_CANCELLED,
  LIVE_BOARDING,
};

// Which board the server chose for the time of day (its `mode` field).
enum BoardMode : uint8_t {
  MODE_MORNING = 0,   // home -> city, today
  MODE_EVENING,       // city -> home, tonight
  MODE_NEXT_MORNING,  // home -> city, tomorrow's first trains
};

// Health of the server's NJ Transit real-time feed (`status.live`).
enum LiveFeed : uint8_t {
  FEED_UNKNOWN = 0,  // older server: field absent
  FEED_OK,
  FEED_DOWN,  // the real-time fetch failed — board is schedule-only
  FEED_OFF,   // not applicable (tomorrow's board) or no credentials
};

// Where a board's drive time came from (`driveSource`).
enum DriveSource : uint8_t {
  DRIVE_NONE = 0,  // no drive estimate at all
  DRIVE_LIVE,      // traffic-aware, measured now
  DRIVE_TYPICAL,   // a fixed typical figure — drawn as "~16 min drive"
};

struct DepView {
  time_t leaveEpoch;  // when to leave home (depart - drive - buffer);
                      // 0 when the server sent none (evening boards, or a
                      // morning board with no drive estimate)
  time_t depEpoch;    // train departs origin
  time_t arrEpoch;    // train arrives destination
  uint8_t live;       // LiveState
  int16_t delayMin;   // minutes late when LIVE_DELAYED (0 = unknown)
  char track[8];      // assigned track, "" until known
};

struct BoardView {
  char origin[28];      // "Morristown"
  char destShort[16];   // "Penn" / "Hoboken"
  int driveMin;         // drive home->origin station, 0 = none
  uint8_t driveSource;  // DriveSource
  DepView deps[6];      // as many as the API sends (TRAINS_PER_BOARD, now 5)
  int nDeps;
};

struct BoardData {
  char headline[48];  // e.g. "To NYC · today"
  int bufferMin;
  uint8_t mode;          // BoardMode
  bool showLeave;        // the big number counts down to LEAVING THE HOUSE
                         // (false = it counts down to the train departing)
  bool scheduleExpired;  // the server's timetable has run out
  uint8_t liveFeed;      // LiveFeed
  BoardView boards[6];
  int nBoards;
  bool ok;           // last fetch parsed successfully
  time_t fetchedAt;  // wall-clock time of the last good fetch (0 = never):
                     // the device clock, or the server's `now` if the device
                     // clock wasn't set yet

  // Fetch bookkeeping (not from the JSON) so the UI can say what's wrong.
  int failStreak;    // consecutive failed fetches since the last good one
  int lastHttpCode;  // last HTTP status; <= 0 = never got an HTTP answer
};
