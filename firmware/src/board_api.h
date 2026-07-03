// firmware/src/board_api.h — fetch + parse the live family-dash board.
#pragma once

#include "board_data.h"

// Fetch BOARD_API_URL over HTTPS and parse it into `out`. Returns true on a
// successful fetch+parse (and sets out.ok / out.fetchedAt); on failure returns
// false and leaves out.ok as-is so the caller can keep showing stale data.
bool board_fetch(BoardData& out, time_t now);
