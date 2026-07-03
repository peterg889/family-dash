// firmware/src/ui.h — renders the fetched family-dash board into a 1-bit canvas.
#pragma once

#include <Adafruit_GFX.h>
#include <time.h>

#include "board_data.h"
#include "net.h"

static const int UI_W = 400;
static const int UI_H = 300;

// One screen per home station; the up/down toggle (or auto-rotate) moves
// between them.
enum UiScreen { SCREEN_MORRISTOWN = 0, SCREEN_BERNARDSVILLE = 1, SCREEN_COUNT = 2 };

// Render `screen` for instant `now` into `canvas` (UI_W x UI_H). `data.ok`
// false → a "can't reach dashboard" state is drawn instead.
void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, UiScreen screen);
