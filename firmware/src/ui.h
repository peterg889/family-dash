// firmware/src/ui.h — renders the fetched family-dash board into a 1-bit canvas.
#pragma once

#include <Adafruit_GFX.h>
#include <time.h>

#include "board_data.h"
#include "net.h"

static const int UI_W = 400;
static const int UI_H = 300;

// How old the board may get before the screen says so. The device refetches
// every 3 min, so 6 min means at least one fetch has already failed.
static const long UI_STALE_SEC = 6 * 60;         // footer: "updated N min ago"
static const long UI_OFFLINE_SEC = 30 * 60;      // inverted OFFLINE banner
static const long UI_OFFLINE_HIDE_SEC = 3 * 3600;  // stop showing the old board

// One screen per home station; the up/down toggle (or auto-rotate) moves
// between them.
enum UiScreen { SCREEN_MORRISTOWN = 0, SCREEN_BERNARDSVILLE = 1, SCREEN_COUNT = 2 };

// Render `screen` for instant `now` into `canvas` (UI_W x UI_H).
//
// The screen never claims "no trains" when the real problem is something
// else: no clock, no WiFi, an unreachable dashboard, an expired timetable and
// an out-of-date board each get their own wording (see ui.cpp).
void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, UiScreen screen);

// True when ui_draw is showing something other than a fresh train board
// (never fetched, stale, offline, expired timetable). main.cpp redraws
// immediately when a fetch clears such a state instead of waiting for the next
// rotate tick.
bool ui_degraded(const BoardData& data, time_t now, bool time_valid);

// A plain full-screen notice (used for "Updating firmware...").
void ui_draw_notice(GFXcanvas1& canvas, const char* title, const char* line1,
                    const char* line2);
