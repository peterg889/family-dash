// firmware/src/ui.h — renders the fetched family-dash board into a 1-bit canvas.
//
// One combined screen: every train to the city from both home stations, in the
// order you'd have to leave the house for them.
#pragma once

#include <Adafruit_GFX.h>
#include <time.h>

#include "board_data.h"
#include "net.h"

static const int UI_W = 400;
static const int UI_H = 300;

// Rows of later trains under the big one; one "page" for the up/down buttons.
static const int UI_ROWS = 5;

// How old the board may get before the screen says so. By day the device
// refetches every 3 min, so 6 min means at least one fetch has already failed;
// at night it only fetches every 15 min, so the limits stretch to match.
static const long UI_STALE_SEC = 6 * 60;           // footer: "updated N min ago"
static const long UI_OFFLINE_SEC = 30 * 60;        // inverted OFFLINE banner
static const long UI_STALE_SEC_NIGHT = 40 * 60;
static const long UI_OFFLINE_SEC_NIGHT = 75 * 60;
// While out of touch the stored trains keep counting down under the OFFLINE
// banner for as long as any remain — but not past this.
static const long UI_OFFLINE_HIDE_SEC = 12 * 3600;

// Night (11 PM – 5 AM local): no clock in the header, so the picture only
// changes when the trains do, and the panel can sit still for hours.
bool ui_is_night(time_t now);

// Render the board for instant `now` into `canvas` (UI_W x UI_H). `page` 0 is
// the next trains; higher pages show later ones (clamped to what exists).
//
// The screen never claims "no trains" when the real problem is something
// else: no clock, no WiFi, an unreachable dashboard, an expired timetable and
// an out-of-date board each get their own wording (see ui.cpp).
void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, int page);

// How many pages of trains there are right now (>= 1).
int ui_page_count(const BoardData& data, time_t now);

// How many still-catchable trains the device is holding (for `status`).
int ui_train_count(const BoardData& data, time_t now);

// True when ui_draw is showing something other than a fresh train board
// (never fetched, stale, offline, expired timetable).
bool ui_degraded(const BoardData& data, time_t now, bool time_valid);

// A plain full-screen notice (used for "Updating firmware...").
void ui_draw_notice(GFXcanvas1& canvas, const char* title, const char* line1,
                    const char* line2);
