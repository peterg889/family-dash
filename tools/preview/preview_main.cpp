// Native preview of the E-Ink UI: builds a mock BoardData for a named scenario
// and renders one station screen to a raw framebuffer, so the layout — and
// every failure state — can be checked without flashing or a network fetch.
//
// argv: [epoch|0] [out.raw] [screen 0=Morristown 1=Bernardsville] [scenario]
//       epoch 0 (or omitted) uses the scenario's own time of day.
//       `--list` prints the scenario names, one per line.
// env:  PREVIEW_MODE=evening is still honoured when no scenario is given.
#include <Adafruit_GFX.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "ui.h"

// ---- builders ---------------------------------------------------------------

static void mk(DepView& d, time_t base, long lv, long dp, long ar) {
  d.leaveEpoch = lv < 0 ? 0 : base + lv;  // lv<0 => server sent no leave time
  d.depEpoch = base + dp;
  d.arrEpoch = base + ar;
}

static void lv(DepView& d, uint8_t state, int delay, const char* trk) {
  d.live = state;
  d.delayMin = (int16_t)delay;
  snprintf(d.track, sizeof(d.track), "%s", trk);
}

static void board(BoardView& b, const char* origin, const char* dest, int drive,
                  uint8_t src) {
  snprintf(b.origin, sizeof(b.origin), "%s", origin);
  snprintf(b.destShort, sizeof(b.destShort), "%s", dest);
  b.driveMin = drive;
  b.driveSource = src;
  b.nDeps = 0;
}

// Morning: home -> city, with a drive leg and "leave in" countdowns.
static void build_morning(BoardData& data, time_t now) {
  strcpy(data.headline, "To NYC today");
  data.mode = MODE_MORNING;
  data.showLeave = true;
  data.liveFeed = FEED_OK;
  data.nBoards = 3;

  board(data.boards[0], "Morristown", "Penn", 16, DRIVE_LIVE);
  data.boards[0].nDeps = 3;
  mk(data.boards[0].deps[0], now, 720, 1980, 6560);  // leave in 12m
  mk(data.boards[0].deps[1], now, 2520, 3780, 8360);
  mk(data.boards[0].deps[2], now, 4320, 5580, 10160);
  lv(data.boards[0].deps[0], LIVE_DELAYED, 6, "3");
  lv(data.boards[0].deps[1], LIVE_ON_TIME, 0, "");
  lv(data.boards[0].deps[2], LIVE_ON_TIME, 0, "1");

  board(data.boards[1], "Bernardsville", "Penn", 9, DRIVE_LIVE);
  data.boards[1].nDeps = 2;
  mk(data.boards[1].deps[0], now, 660, 1500, 6100);  // leave in 11m
  mk(data.boards[1].deps[1], now, 3160, 4000, 8600);
  lv(data.boards[1].deps[0], LIVE_ON_TIME, 0, "2");
  lv(data.boards[1].deps[1], LIVE_DELAYED, 0, "");  // delayed, amount unknown

  board(data.boards[2], "Bernardsville", "Hoboken", 9, DRIVE_LIVE);
  data.boards[2].nDeps = 2;
  mk(data.boards[2].deps[0], now, 1560, 2400, 5000);
  mk(data.boards[2].deps[1], now, 5000, 5840, 8440);
  lv(data.boards[2].deps[0], LIVE_ON_TIME, 0, "");
}

// Evening: city -> home, no drive leg so the countdown tracks the departure.
// The Bernardsville screen draws trains from two terminals.
static void build_evening(BoardData& data, time_t now) {
  strcpy(data.headline, "Heading home tonight");
  data.mode = MODE_EVENING;
  data.showLeave = false;
  data.liveFeed = FEED_OK;
  data.nBoards = 3;

  board(data.boards[0], "New York Penn Station", "Morristown", 0, DRIVE_NONE);
  data.boards[0].nDeps = 3;
  mk(data.boards[0].deps[0], now, -1, 900, 4300);  // departs in 15m
  mk(data.boards[0].deps[1], now, -1, 3600, 7000);
  mk(data.boards[0].deps[2], now, -1, 6300, 9900);
  lv(data.boards[0].deps[0], LIVE_DELAYED, 8, "7");
  lv(data.boards[0].deps[1], LIVE_ON_TIME, 0, "");

  board(data.boards[1], "New York Penn Station", "Bernardsville", 0, DRIVE_NONE);
  data.boards[1].nDeps = 2;
  mk(data.boards[1].deps[0], now, -1, 1500, 6100);
  mk(data.boards[1].deps[1], now, -1, 5100, 9700);
  lv(data.boards[1].deps[0], LIVE_ON_TIME, 0, "12");
  lv(data.boards[1].deps[1], LIVE_ON_TIME, 0, "");

  board(data.boards[2], "Hoboken", "Bernardsville", 0, DRIVE_NONE);
  data.boards[2].nDeps = 2;
  mk(data.boards[2].deps[0], now, -1, 2400, 5000);
  mk(data.boards[2].deps[1], now, -1, 5840, 8440);
  lv(data.boards[2].deps[0], LIVE_BOARDING, 0, "1");
  lv(data.boards[2].deps[1], LIVE_ON_TIME, 0, "2");
}

// Next morning (shown from 8 PM): tomorrow's first trains, schedule only.
static void build_next_morning(BoardData& data, time_t now) {
  strcpy(data.headline, "To NYC tomorrow morning");
  data.mode = MODE_NEXT_MORNING;
  data.showLeave = true;
  data.liveFeed = FEED_OFF;
  data.nBoards = 3;
  const long H = 3600;

  board(data.boards[0], "Morristown", "Penn", 16, DRIVE_TYPICAL);
  data.boards[0].nDeps = 3;
  mk(data.boards[0].deps[0], now, 9 * H + 1020, 9 * H + 2280, 13 * H + 240);
  mk(data.boards[0].deps[1], now, 9 * H + 2700, 10 * H + 360, 14 * H + 900);
  mk(data.boards[0].deps[2], now, 10 * H + 900, 10 * H + 2160, 15 * H + 300);

  board(data.boards[1], "Bernardsville", "Penn", 9, DRIVE_TYPICAL);
  data.boards[1].nDeps = 1;
  mk(data.boards[1].deps[0], now, 9 * H + 2460, 9 * H + 3300, 14 * H + 600);

  board(data.boards[2], "Bernardsville", "Hoboken", 9, DRIVE_TYPICAL);
  data.boards[2].nDeps = 2;
  mk(data.boards[2].deps[0], now, 9 * H + 1260, 9 * H + 2100, 13 * H + 1200);
  mk(data.boards[2].deps[1], now, 10 * H + 600, 10 * H + 1440, 14 * H + 2400);
}

static void clear_live(BoardData& data) {
  for (int i = 0; i < data.nBoards; i++)
    for (int j = 0; j < data.boards[i].nDeps; j++)
      lv(data.boards[i].deps[j], LIVE_NONE, 0, "");
}

static void drop_trains(BoardData& data) {
  for (int i = 0; i < data.nBoards; i++) data.boards[i].nDeps = 0;
}

// ---- scenarios --------------------------------------------------------------

struct Scenario {
  const char* name;
  int hour, minute;  // local time of day used when no epoch is given
  const char* what;
};

static const Scenario SCENARIOS[] = {
    {"morning", 7, 5, "normal morning board, live status"},
    {"evening", 17, 20, "normal evening board (city -> home)"},
    {"next-morning", 21, 15, "tomorrow's first trains, labelled TOMORROW"},
    {"hour-plus", 10, 40, "hero more than an hour away"},
    {"cancelled-first", 7, 5, "first train cancelled: hero is the next one"},
    {"all-cancelled", 7, 5, "every listed train cancelled"},
    {"typical-drive", 7, 5, "drive time is a typical figure (~16 min)"},
    {"no-drive-time", 7, 5, "leave board without a drive estimate"},
    {"live-down", 7, 5, "NJ Transit real-time feed failed: schedule only"},
    {"stale-footer", 7, 5, "board 14 min old"},
    {"stale-wifi", 7, 5, "board 14 min old and WiFi is down"},
    {"offline-banner", 7, 5, "board 47 min old: OFFLINE banner"},
    {"offline-empty", 9, 50, "old board with no trains left: offline message"},
    {"offline-hours", 13, 30, "board from hours ago: offline message"},
    {"wifi-down", 7, 5, "never fetched, WiFi not connected"},
    {"never-fetched", 7, 5, "WiFi up, first fetch still in flight"},
    {"unreachable", 7, 5, "WiFi up, fetches failing (HTTP 500)"},
    {"no-clock", 7, 5, "clock not set yet"},
    {"schedule-expired", 7, 5, "server timetable expired, no trains"},
    {"expired-live-only", 7, 5, "timetable expired but live trains shown"},
    {"no-trains-today", 7, 5, "fresh board, no trains (morning)"},
    {"no-trains-tonight", 17, 20, "fresh board, no trains (evening)"},
    {"no-trains-tomorrow", 21, 15, "fresh board, no trains (next morning)"},
    {"updating", 7, 5, "firmware update notice"},
};
static const int N_SCENARIOS = sizeof(SCENARIOS) / sizeof(SCENARIOS[0]);

static const Scenario* find(const char* name) {
  for (int i = 0; i < N_SCENARIOS; i++)
    if (!strcmp(SCENARIOS[i].name, name)) return &SCENARIOS[i];
  return nullptr;
}

static time_t scenario_epoch(const Scenario& s) {
  struct tm tm = {};
  tm.tm_year = 2026 - 1900;
  tm.tm_mon = 11;  // Wednesday 2 December 2026
  tm.tm_mday = 2;
  tm.tm_hour = s.hour;
  tm.tm_min = s.minute;
  tm.tm_isdst = -1;
  return mktime(&tm);
}

int main(int argc, char** argv) {
  setenv("TZ", "EST5EDT,M3.2.0,M11.1.0", 1);
  tzset();
  if (argc > 1 && !strcmp(argv[1], "--list")) {
    for (int i = 0; i < N_SCENARIOS; i++) puts(SCENARIOS[i].name);
    return 0;
  }

  const char* out = argc > 2 ? argv[2] : "preview.raw";
  UiScreen screen =
      (argc > 3 && atoi(argv[3]) == 1) ? SCREEN_BERNARDSVILLE : SCREEN_MORRISTOWN;
  const char* name = argc > 4 ? argv[4] : nullptr;
  if (!name || !name[0]) {
    const char* mode = getenv("PREVIEW_MODE");
    name = (mode && !strcmp(mode, "evening")) ? "evening" : "morning";
  }
  const Scenario* sc = find(name);
  if (!sc) {
    fprintf(stderr, "unknown scenario '%s' (try --list)\n", name);
    return 2;
  }
  const char* s = sc->name;
  time_t now = argc > 1 ? (time_t)atoll(argv[1]) : 0;
  if (now == 0) now = scenario_epoch(*sc);

  BoardData data{};
  data.bufferMin = 5;
  data.ok = true;
  data.fetchedAt = now - 40;
  data.lastHttpCode = 200;
  net_state_t net = NET_CONNECTED;
  bool timeValid = true;

  if (!strcmp(s, "evening") || !strcmp(s, "no-trains-tonight"))
    build_evening(data, now);
  else if (!strcmp(s, "next-morning") || !strcmp(s, "no-trains-tomorrow"))
    build_next_morning(data, now);
  else
    build_morning(data, now);

  if (!strcmp(s, "hour-plus")) {
    for (int i = 0; i < data.nBoards; i++)
      for (int j = 0; j < data.boards[i].nDeps; j++) {
        DepView& d = data.boards[i].deps[j];
        d.leaveEpoch += 4320;
        d.depEpoch += 4320;
        d.arrEpoch += 4320;
      }
    clear_live(data);
  } else if (!strcmp(s, "cancelled-first")) {
    lv(data.boards[0].deps[0], LIVE_CANCELLED, 0, "");
    lv(data.boards[1].deps[0], LIVE_CANCELLED, 0, "");
    lv(data.boards[2].deps[1], LIVE_CANCELLED, 0, "");
  } else if (!strcmp(s, "all-cancelled")) {
    for (int i = 0; i < data.nBoards; i++)
      for (int j = 0; j < data.boards[i].nDeps; j++)
        lv(data.boards[i].deps[j], LIVE_CANCELLED, 0, "");
  } else if (!strcmp(s, "typical-drive")) {
    for (int i = 0; i < data.nBoards; i++)
      data.boards[i].driveSource = DRIVE_TYPICAL;
  } else if (!strcmp(s, "no-drive-time")) {
    for (int i = 0; i < data.nBoards; i++) {
      data.boards[i].driveMin = 0;
      data.boards[i].driveSource = DRIVE_NONE;
      for (int j = 0; j < data.boards[i].nDeps; j++)
        data.boards[i].deps[j].leaveEpoch = 0;
    }
  } else if (!strcmp(s, "live-down")) {
    clear_live(data);
    data.liveFeed = FEED_DOWN;
  } else if (!strcmp(s, "stale-footer")) {
    data.fetchedAt = now - 14 * 60;
    data.failStreak = 9;
    data.lastHttpCode = -1;
  } else if (!strcmp(s, "stale-wifi")) {
    data.fetchedAt = now - 14 * 60;
    net = NET_CONNECTING;
  } else if (!strcmp(s, "offline-banner")) {
    data.fetchedAt = now - 47 * 60;
    net = NET_DISCONNECTED;
    // Trains still ahead on a 47-minute-old board.
    for (int i = 0; i < data.nBoards; i++)
      for (int j = 0; j < data.boards[i].nDeps; j++) {
        DepView& d = data.boards[i].deps[j];
        d.leaveEpoch += 900;
        d.depEpoch += 900;
        d.arrEpoch += 900;
      }
  } else if (!strcmp(s, "offline-empty")) {
    // Fetched at 7:05; by 9:50 every train on it has gone.
    data.fetchedAt = now - (2 * 3600 + 45 * 60);
    for (int i = 0; i < data.nBoards; i++)
      for (int j = 0; j < data.boards[i].nDeps; j++) {
        DepView& d = data.boards[i].deps[j];
        d.leaveEpoch -= 3 * 3600;
        d.depEpoch -= 3 * 3600;
        d.arrEpoch -= 3 * 3600;
      }
  } else if (!strcmp(s, "offline-hours")) {
    data.fetchedAt = now - (5 * 3600 + 25 * 60);
    net = NET_DISCONNECTED;
  } else if (!strcmp(s, "wifi-down")) {
    data = BoardData{};
    net = NET_CONNECTING;
  } else if (!strcmp(s, "never-fetched")) {
    data = BoardData{};
  } else if (!strcmp(s, "unreachable")) {
    data = BoardData{};
    data.failStreak = 3;
    data.lastHttpCode = 500;
  } else if (!strcmp(s, "no-clock")) {
    timeValid = false;
  } else if (!strcmp(s, "schedule-expired")) {
    drop_trains(data);
    data.scheduleExpired = true;
    data.liveFeed = FEED_DOWN;
  } else if (!strcmp(s, "expired-live-only")) {
    data.scheduleExpired = true;
  } else if (!strncmp(s, "no-trains-", 10)) {
    drop_trains(data);
  }

  GFXcanvas1 canvas(UI_W, UI_H);
  if (!strcmp(s, "updating"))
    ui_draw_notice(canvas, "Updating firmware...",
                   "A new version is being installed over WiFi.",
                   "The board restarts by itself when it's done.");
  else
    ui_draw(canvas, data, now, net, timeValid, screen);

  size_t bytes = ((UI_W + 7) / 8) * UI_H;
  FILE* f = fopen(out, "wb");
  if (!f) {
    perror(out);
    return 1;
  }
  fwrite(canvas.getBuffer(), 1, bytes, f);
  fclose(f);
  fprintf(stderr, "wrote %s scenario=%s now=%lld screen=%d degraded=%d\n", out, s,
          (long long)now, (int)screen,
          (int)ui_degraded(data, now, timeValid));
  return 0;
}
