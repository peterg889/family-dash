// firmware/src/timekeeper.h — NTP clock + America/New_York timezone.
#pragma once

#include <stdbool.h>
#include <time.h>

// Set TZ=America/New_York and start SNTP. Safe to call once WiFi is up;
// the ESP32 SNTP client keeps re-syncing in the background afterward.
void time_begin(void);

// True once the clock reads a plausible wall-clock time (year >= 2024),
// i.e. NTP has completed at least one sync.
bool time_valid(void);

// Current wall-clock instant (unix seconds). NY local calendar/DST is
// applied by localtime_r()/mktime() because time_begin() sets TZ.
time_t time_now(void);
