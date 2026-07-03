// Native cross-check of the C++ departures port. Reads unix-second timestamps
// (one per line) from argv[1] and emits the same canonical format as ref.mjs:
//
//   <epochSec> B<boardIdx> dep|routeShort|headsign|dur ; dep|...
//
// Build + run via tools/test/run.sh. TZ is forced to America/New_York so
// mktime()/localtime_r() match the reference's Intl math.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "departures.h"
#include "schedule_data.h"

int main(int argc, char** argv) {
  setenv("TZ", "EST5EDT,M3.2.0,M11.1.0", 1);
  tzset();

  if (argc < 2) { fprintf(stderr, "usage: %s cases.txt\n", argv[0]); return 2; }
  FILE* f = fopen(argv[1], "r");
  if (!f) { perror("open"); return 2; }

  char line[64];
  while (fgets(line, sizeof(line), f)) {
    if (line[0] == '\n' || line[0] == '\0') continue;
    time_t now = (time_t)strtoll(line, nullptr, 10);
    for (int bi = 0; bi < SCHED_NUM_BOARDS; bi++) {
      Departure out[DEP_MAX];
      int n = departures_for_board(bi, now, out, 4);
      printf("%lld B%d ", (long long)now, bi);
      for (int i = 0; i < n; i++) {
        if (i) printf(" ; ");
        printf("%lld|%s|%s|%d", (long long)out[i].depEpoch,
               SCHED_ROUTE[out[i].route].shortName,
               SCHED_HEADSIGN[out[i].headsign], out[i].durationMin);
      }
      printf("\n");
    }
  }
  fclose(f);
  return 0;
}
