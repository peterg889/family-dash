// firmware/src/board_data.h — parsed shape of the family-dash /api/departures
// response. Shared by board_parse.cpp (fills it from the fetched JSON) and
// ui.cpp (renders it). Kept free of Arduino headers so the native preview and
// the contract check can build against it on a laptop.
#pragma once

#include <stdint.h>
#include <time.h>

// Live DepartureVision status. LIVE_NONE = no live data for this train (e.g.
// tomorrow's trains, or the upstream API was unreachable); LIVE_ON_TIME
// covers both "on-time" and "unknown" — tracked, nothing to flag.
enum LiveState : uint8_t {
  LIVE_NONE = 0,
  LIVE_ON_TIME,
  LIVE_DELAYED,  // delayMin == 0 means "delayed, by an unknown amount"
  LIVE_CANCELLED,
  LIVE_BOARDING,
};

// Which board the server chose (its `mode` field). The sign asks for
// direction=outbound, so in practice it only ever gets the first and the last.
enum BoardMode : uint8_t {
  MODE_MORNING = 0,   // home -> city, today's remaining trains
  MODE_EVENING,       // city -> home (never requested by the sign)
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
  DRIVE_LIVE,      // traffic-aware, measured in the last few minutes
  DRIVE_EARLIER,   // Google's most recent measurement, not from the last few
                   // minutes — drawn as "~16 min drive"
};

// Capacity. The sign asks the server for 12 trains per board so it can keep
// counting down for hours if the network goes away; hold a few more than that.
static const int MAX_BOARDS = 6;
static const int MAX_DEPS = 16;

struct DepView {
  time_t leaveEpoch;  // when to leave home (depart - drive - buffer);
                      // 0 when the server sent none (no drive estimate)
  time_t depEpoch;    // train departs origin
  time_t arrEpoch;    // train arrives destination
  uint8_t live;       // LiveState
  int16_t delayMin;   // minutes late when LIVE_DELAYED (0 = unknown)
};

struct BoardView {
  char origin[28];      // "Morristown"
  char destShort[16];   // "Penn" / "Hoboken"
  int driveMin;         // drive home->origin station, 0 = none
  uint8_t driveSource;  // DriveSource
  DepView deps[MAX_DEPS];
  int nDeps;
};

struct BoardData {
  char headline[48];  // e.g. "To NYC · today" (only used to infer the mode
                      // from an older server)
  uint8_t mode;          // BoardMode
  bool showLeave;        // the big number counts down to LEAVING THE HOUSE
                         // (false = it counts down to the train departing)
  bool scheduleExpired;  // the server's timetable has run out
  uint8_t liveFeed;      // LiveFeed
  char alert[200];       // first NJ Transit service alert, "" when none
  int nAlerts;           // how many alerts the server sent
  BoardView boards[MAX_BOARDS];
  int nBoards;
  bool ok;           // last fetch parsed successfully
  time_t serverNow;  // the server's clock in the response (0 = absent)
  time_t fetchedAt;  // wall-clock time of the last good fetch (0 = never):
                     // the device clock, or the server's `now` if the device
                     // clock wasn't set yet

  // Fetch bookkeeping (not from the JSON) so the UI can say what's wrong.
  int failStreak;    // consecutive failed fetches since the last good one
  int lastHttpCode;  // last HTTP status; <= 0 = never got an HTTP answer
};
