// firmware/src/timekeeper.cpp — see timekeeper.h.
#include "timekeeper.h"
#include "config.h"

#include <Arduino.h>

void time_begin(void) {
  // configTzTime installs the POSIX TZ rule *and* starts SNTP, so
  // localtime_r()/mktime() immediately resolve NY local time with DST.
  configTzTime(TZ_POSIX, NTP_SERVER_1, NTP_SERVER_2, NTP_SERVER_3);
  Serial.printf("Time: SNTP started, TZ=%s\n", TZ_POSIX);
}

bool time_valid(void) {
  time_t t = time(nullptr);
  struct tm tm;
  localtime_r(&t, &tm);
  return (tm.tm_year + 1900) >= 2024;
}

time_t time_now(void) { return time(nullptr); }
