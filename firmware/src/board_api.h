// firmware/src/board_api.h — fetch the live family-dash board over HTTPS.
#pragma once

#include "board_data.h"

// Fetch BOARD_API_URL and parse it into `out` (board_parse.h does the parsing).
//
// On success: replaces the board in `out`, sets out.ok, clears
// out.failStreak, and stamps out.fetchedAt (`now` when `clock_valid`,
// otherwise the server's own clock from the response).
//
// On failure: returns false, bumps out.failStreak / records
// out.lastHttpCode, and leaves the previous board untouched so the caller can
// keep showing it (the UI marks it stale from out.fetchedAt).
bool board_fetch(BoardData& out, time_t now, bool clock_valid);
