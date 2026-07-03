// firmware/src/departures.cpp — see departures.h.
//
// Faithful port of lib/departures.ts `nextDepartures`. Instead of the TS
// Intl-based timezone math, this uses newlib mktime()/localtime_r() with
// TZ=America/New_York, which handles DST and after-midnight (24:xx / 25:xx)
// GTFS times identically: a departure encoded as e.g. 24:30:00 becomes
// dayMidnight + 88200s, which naturally lands on the following calendar day.
#include "departures.h"
#include "schedule_data.h"

// Is service `svc` active on `key` (YYYYMMDD)? Binary search — the date
// arrays are emitted sorted ascending by the generator.
static bool service_runs(uint8_t svc, uint32_t key) {
  const SchedService& s = SCHED_SERVICE[svc];
  int lo = 0, hi = (int)s.count - 1;
  while (lo <= hi) {
    int mid = (lo + hi) >> 1;
    uint32_t v = s.dates[mid];
    if (v == key) return true;
    if (v < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

int departures_for_board(int boardIdx, time_t now, Departure* out, int limit) {
  if (limit > DEP_MAX) limit = DEP_MAX;
  const SchedBoard& b = SCHED_BOARD[boardIdx];

  struct tm now_tm;
  localtime_r(&now, &now_tm);  // NY calendar date of `now`

  // Collect candidates across yesterday/today/tomorrow service dates so that
  // after-midnight trips and early-morning trips both resolve.
  const int MAXC = 48;
  Departure cand[MAXC];
  int nc = 0;

  for (int off = -1; off <= 1; off++) {
    // GTFS anchors a service day at "noon - 12h", which equals local midnight
    // on ordinary days but is the correct reference on DST-change days (a
    // fall-back day is 25h long, so local midnight is an hour off). Anchoring
    // on noon and subtracting 12h keeps GTFS times aligned across the Nov DST
    // transition. mktime() normalizes the date and applies NY DST.
    struct tm noon;
    noon.tm_year = now_tm.tm_year;
    noon.tm_mon = now_tm.tm_mon;
    noon.tm_mday = now_tm.tm_mday + off;
    noon.tm_hour = 12;
    noon.tm_min = 0;
    noon.tm_sec = 0;
    noon.tm_isdst = -1;
    time_t noonEpoch = mktime(&noon);  // normalizes the struct in place
    if (noonEpoch == (time_t)-1) continue;
    time_t dayAnchor = noonEpoch - 12 * 3600;

    // Post-normalization Y/M/D is this service day's date key.
    uint32_t key = (uint32_t)(noon.tm_year + 1900) * 10000u +
                   (uint32_t)(noon.tm_mon + 1) * 100u +
                   (uint32_t)noon.tm_mday;

    for (int i = 0; i < SCHED_NUM_TRIPS; i++) {
      const SchedTrip& t = SCHED_TRIP[i];
      if (t.origin != b.origin || t.dest != b.dest) continue;
      if (!service_runs(t.service, key)) continue;

      time_t depEpoch = dayAnchor + (time_t)t.depSec;
      if (depEpoch < now) continue;

      // Dedup by departure instant (a trip can match in two day windows).
      bool dup = false;
      for (int j = 0; j < nc; j++) {
        if (cand[j].depEpoch == depEpoch) { dup = true; break; }
      }
      if (dup) continue;
      if (nc >= MAXC) continue;

      time_t arrEpoch = dayAnchor + (time_t)t.arrSec;
      long secs = (long)(arrEpoch - depEpoch);
      int dur = secs <= 0 ? 0 : (int)((secs + 30) / 60);  // round to minutes

      cand[nc].depEpoch = depEpoch;
      cand[nc].arrEpoch = arrEpoch;
      cand[nc].route = t.route;
      cand[nc].headsign = t.headsign;
      cand[nc].durationMin = dur;
      nc++;
    }
  }

  // Sort ascending by departure (insertion sort — nc is small).
  for (int i = 1; i < nc; i++) {
    Departure k = cand[i];
    int j = i - 1;
    while (j >= 0 && cand[j].depEpoch > k.depEpoch) {
      cand[j + 1] = cand[j];
      j--;
    }
    cand[j + 1] = k;
  }

  int n = nc < limit ? nc : limit;
  for (int i = 0; i < n; i++) out[i] = cand[i];
  return n;
}
