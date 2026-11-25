// firmware/src/board_parse.h — /api/departures JSON -> BoardData.
//
// Deliberately free of Arduino: only ArduinoJson (header-only, builds anywhere)
// and the C library. The firmware calls it from board_api.cpp; on a laptop the
// very same file is compiled into tools/preview and tools/contract, so the
// server's real responses can be run through the device's real parser in CI.
#pragma once

#include <stddef.h>
#include <time.h>

#include "board_data.h"

// Parse `json` (`len` bytes) into `out`.
//
// On success returns true and REPLACES the board in `out` (out.ok set,
// out.failStreak cleared, out.fetchedAt stamped: `now` when `clock_valid`,
// otherwise the server's own clock from the response). out.lastHttpCode is left
// for the caller.
//
// On failure returns false, leaves `out` completely untouched, and — if `why`
// is given — points it at a short static reason ("IncompleteInput",
// "no boards[]", ...).
bool board_parse(const char* json, size_t len, BoardData& out, time_t now,
                 bool clock_valid, const char** why = nullptr);
