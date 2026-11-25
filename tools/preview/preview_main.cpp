// Native preview of the E-Ink UI. Renders the combined screen to a raw
// framebuffer on a laptop — from a named mock scenario (every state the screen
// can be in, including the failure ones), or from a real /api/departures
// response run through the device's own parser (firmware/src/board_parse.cpp).
//
//   preview --list
//   preview [epoch|0] [out.raw] [page] [scenario]
//         epoch 0 (or omitted) uses the scenario's own time of day
//   preview --json  <api.json> [out.raw] [epoch|0] [page]
//         epoch 0 (or omitted) renders at the response's own `now`
//   preview --check <api.json> [out.raw]
//         the contract check: parse, sanity-check, render; exit 1 on failure
#include <Adafruit_GFX.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <string>

#include "board_parse.h"
#include "ui.h"

// ---- mock builders ----------------------------------------------------------

static time_t g_day0;  // local midnight of the scenario day

static time_t at(int h, int m) { return g_day0 + h * 3600L + m * 60L; }

static void board(BoardView& b, const char* origin, const char* dest, int drive,
                  uint8_t src) {
  snprintf(b.origin, sizeof(b.origin), "%s", origin);
  snprintf(b.destShort, sizeof(b.destShort), "%s", dest);
  b.driveMin = drive;
  b.driveSource = src;
  b.nDeps = 0;
}

// Add a train departing at dh:dm, arriving ah:am. The leave time is what the
// server would send: departure - drive - 5 min buffer (none without a drive).
static DepView& train(BoardView& b, int dh, int dm, int ah, int am) {
  DepView& d = b.deps[b.nDeps++];
  d.depEpoch = at(dh, dm);
  d.arrEpoch = at(ah, am);
  d.leaveEpoch = b.driveMin > 0 ? d.depEpoch - (b.driveMin + 5) * 60L - 17 : 0;
  d.live = LIVE_ON_TIME;
  d.delayMin = 0;
  return d;
}

static void lv(DepView& d, uint8_t state, int delay) {
  d.live = state;
  d.delayMin = (int16_t)delay;
}

// A weekday morning: 13 trains to the city across the three boards.
static void build_morning(BoardData& data) {
  snprintf(data.headline, sizeof(data.headline), "To NYC today");
  data.mode = MODE_MORNING;
  data.showLeave = true;
  data.liveFeed = FEED_OK;
  data.nBoards = 3;

  BoardView& mor = data.boards[0];
  board(mor, "Morristown", "Penn", 16, DRIVE_LIVE);
  lv(train(mor, 7, 38, 8, 54), LIVE_DELAYED, 6);
  train(mor, 8, 8, 9, 24);
  train(mor, 8, 38, 9, 54);
  train(mor, 9, 8, 10, 24);
  train(mor, 9, 38, 10, 54);
  train(mor, 10, 27, 11, 29);
  train(mor, 11, 11, 12, 21);
  train(mor, 12, 18, 13, 27);

  BoardView& bvp = data.boards[1];
  board(bvp, "Bernardsville", "Penn", 9, DRIVE_LIVE);
  train(bvp, 8, 11, 9, 28);

  BoardView& bvh = data.boards[2];
  board(bvh, "Bernardsville", "Hoboken", 9, DRIVE_LIVE);
  train(bvh, 7, 45, 8, 28);
  train(bvh, 8, 36, 9, 19);
  train(bvh, 10, 11, 11, 27);
  train(bvh, 11, 12, 12, 29);
}

// From 8 PM: tomorrow's trains from 6:30 AM, timetable only, earlier drive.
static void build_tomorrow(BoardData& data) {
  snprintf(data.headline, sizeof(data.headline), "To NYC tomorrow morning");
  data.mode = MODE_NEXT_MORNING;
  data.showLeave = true;
  data.liveFeed = FEED_OFF;
  data.nBoards = 3;
  const int T = 24;  // hours into tomorrow

  BoardView& mor = data.boards[0];
  board(mor, "Morristown", "Penn", 19, DRIVE_EARLIER);
  train(mor, T + 6, 33, T + 7, 41);
  train(mor, T + 7, 4, T + 8, 12);
  train(mor, T + 7, 24, T + 8, 39);
  train(mor, T + 7, 52, T + 9, 2);
  train(mor, T + 8, 28, T + 9, 34);

  BoardView& bvp = data.boards[1];
  board(bvp, "Bernardsville", "Penn", 10, DRIVE_EARLIER);
  train(bvp, T + 6, 49, T + 8, 3);

  BoardView& bvh = data.boards[2];
  board(bvh, "Bernardsville", "Hoboken", 10, DRIVE_EARLIER);
  train(bvh, T + 6, 30, T + 7, 41);
  train(bvh, T + 7, 5, T + 8, 12);
  train(bvh, T + 7, 34, T + 8, 43);
  for (int i = 0; i < data.nBoards; i++)
    for (int j = 0; j < data.boards[i].nDeps; j++)
      lv(data.boards[i].deps[j], LIVE_NONE, 0);
}

static void clear_live(BoardData& data) {
  for (int i = 0; i < data.nBoards; i++)
    for (int j = 0; j < data.boards[i].nDeps; j++)
      lv(data.boards[i].deps[j], LIVE_NONE, 0);
}

static void drop_trains(BoardData& data) {
  for (int i = 0; i < data.nBoards; i++) data.boards[i].nDeps = 0;
}

// ---- scenarios --------------------------------------------------------------

struct Scenario {
  const char* name;
  int hour, minute;  // local time of day used when no epoch is given
  int page;          // page shown when none is given
  const char* what;
};

static const Scenario SCENARIOS[] = {
    {"morning", 7, 5, 0, "normal morning: countdown, leave-by, five later trains"},
    {"time-to-go", 7, 17, 0, "the leave time is now"},
    {"leave-at", 5, 10, 0, "next train more than 90 min off: clock time, no countdown"},
    {"tomorrow", 21, 15, 0, "from 8 PM: tomorrow morning's trains"},
    {"night", 23, 40, 0, "night: no clock, static until the trains change"},
    {"small-hours", 2, 10, 0, "after midnight: today's first trains, still static"},
    {"night-early-train", 4, 0, 0, "4 AM, a train 16 min off: still a clock time at night"},
    {"delayed", 7, 5, 0, "delays, a late-by-unknown, a 2-minute delay not flagged"},
    {"boarding", 7, 5, 0, "hero train is boarding"},
    {"cancelled-first", 7, 5, 0, "first train cancelled: hero is the next one"},
    {"all-cancelled", 7, 5, 0, "every train cancelled"},
    {"earlier-drive", 7, 5, 0, "drive time is an earlier measurement (~16 min)"},
    {"no-drive-time", 7, 5, 0, "no drive estimate: the number is the train's departure"},
    {"alert", 7, 5, 0, "NJ Transit service alert (long text): one line of it"},
    {"alert-next-minute", 7, 6, 0, "the same alert a minute later: the next line"},
    {"alert-short", 7, 5, 0, "a service alert short enough for one line"},
    {"second-page", 7, 5, 1, "paged to later trains with the down button"},
    {"last-page", 7, 5, 2, "last page of later trains"},
    {"live-down", 7, 5, 0, "NJ Transit real-time feed failed: schedule only"},
    {"stale-footer", 7, 5, 0, "board 14 min old"},
    {"stale-wifi", 7, 5, 0, "board 14 min old and WiFi is down"},
    {"offline-banner", 7, 5, 0, "board 47 min old: OFFLINE banner, trains still shown"},
    {"offline-hours", 10, 30, 0, "offline for hours: stored trains still counting down"},
    {"offline-long", 13, 30, 0, "old board with no trains left: offline message"},
    {"wifi-down", 7, 5, 0, "never fetched, WiFi not connected"},
    {"never-fetched", 7, 5, 0, "WiFi up, first fetch still in flight"},
    {"unreachable", 7, 5, 0, "WiFi up, fetches failing (HTTP 500)"},
    {"no-clock", 7, 5, 0, "clock not set yet"},
    {"schedule-expired", 7, 5, 0, "server timetable expired, no trains"},
    {"expired-live-only", 7, 5, 0, "timetable expired but live trains shown"},
    {"no-trains", 22, 30, 0, "fresh board, nothing left today"},
    {"no-trains-tomorrow", 21, 15, 0, "fresh board, nothing tomorrow morning"},
    {"updating", 7, 5, 0, "firmware update notice"},
};
static const int N_SCENARIOS = sizeof(SCENARIOS) / sizeof(SCENARIOS[0]);

static const Scenario* find(const char* name) {
  for (int i = 0; i < N_SCENARIOS; i++)
    if (!strcmp(SCENARIOS[i].name, name)) return &SCENARIOS[i];
  return nullptr;
}

static time_t scenario_day0() {
  struct tm tm = {};
  tm.tm_year = 2026 - 1900;
  tm.tm_mon = 11;  // Wednesday 2 December 2026
  tm.tm_mday = 2;
  tm.tm_isdst = -1;
  return mktime(&tm);
}

static bool write_canvas(GFXcanvas1& canvas, const char* out) {
  size_t bytes = ((UI_W + 7) / 8) * UI_H;
  FILE* f = fopen(out, "wb");
  if (!f) {
    perror(out);
    return false;
  }
  fwrite(canvas.getBuffer(), 1, bytes, f);
  fclose(f);
  return true;
}

// ---- real API responses -------------------------------------------------------

static bool read_file(const char* path, std::string& out) {
  FILE* f = fopen(path, "rb");
  if (!f) {
    perror(path);
    return false;
  }
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out.append(buf, n);
  fclose(f);
  return true;
}

// The value of a top-level-ish `"key":` in raw JSON text, as written (used only
// to cross-check the parser against the text, independently of ArduinoJson).
static std::string raw_value(const std::string& json, const char* key) {
  std::string needle = std::string("\"") + key + "\"";
  size_t p = json.find(needle);
  if (p == std::string::npos) return "";
  p = json.find(':', p + needle.size());
  if (p == std::string::npos) return "";
  p++;
  while (p < json.size() && (json[p] == ' ' || json[p] == '"')) p++;
  size_t e = p;
  while (e < json.size() && json[e] != ',' && json[e] != '"' && json[e] != '}')
    e++;
  return json.substr(p, e - p);
}

static int fail(const char* msg) {
  fprintf(stderr, "CONTRACT FAIL: %s\n", msg);
  return 1;
}

// Parse a real response with the device's parser; optionally hold it to the
// contract. Renders at `epoch` (0 = the response's own `now`).
static int run_json(const char* path, const char* out, time_t epoch, int page,
                    bool check) {
  std::string json;
  if (!read_file(path, json)) return 2;

  BoardData data{};
  const char* why = "?";
  if (!board_parse(json.c_str(), json.size(), data, 0, false, &why)) {
    fprintf(stderr, "CONTRACT FAIL: the device parser rejected %s (%s)\n", path,
            why);
    return 1;
  }
  data.lastHttpCode = 200;
  time_t now = epoch ? epoch : data.serverNow;
  if (now == 0) now = time(nullptr);
  data.fetchedAt = now - 20;  // as if just fetched

  int trains = 0;
  for (int i = 0; i < data.nBoards; i++) trains += data.boards[i].nDeps;
  const int catchable = ui_train_count(data, now);
  printf("parsed %s: %d boards, %d trains (%d still catchable at %lld), "
         "mode=%d showLeave=%d expired=%d live=%d alerts=%d\n",
         path, data.nBoards, trains, catchable, (long long)now, (int)data.mode,
         (int)data.showLeave, (int)data.scheduleExpired, (int)data.liveFeed,
         data.nAlerts);
  for (int i = 0; i < data.nBoards; i++)
    printf("  %s -> %s: %d trains, drive %d min (source %d)\n",
           data.boards[i].origin, data.boards[i].destShort,
           data.boards[i].nDeps, data.boards[i].driveMin,
           (int)data.boards[i].driveSource);

  if (check) {
    // The response must carry what the screen is built from...
    if (data.serverNow < 1700000000) return fail("`now` missing or not epoch ms");
    const std::string mode = raw_value(json, "mode");
    const std::string showLeave = raw_value(json, "showLeave");
    if (mode.empty()) return fail("`mode` missing");
    if (showLeave.empty()) return fail("`showLeave` missing");
    // ...and the parser must have read it the way it is written.
    const int wantMode = mode == "evening" ? MODE_EVENING
                         : mode == "next-morning" ? MODE_NEXT_MORNING
                         : mode == "morning" ? MODE_MORNING : -1;
    if (wantMode < 0) return fail("`mode` has a value the device doesn't know");
    if (wantMode != (int)data.mode) return fail("`mode` was not read correctly");
    if ((showLeave == "true") != data.showLeave)
      return fail("`showLeave` was not read correctly");
    if (raw_value(json, "live").empty() || data.liveFeed == FEED_UNKNOWN)
      return fail("`status.live` missing or unrecognised");

    if (data.nBoards < 1) return fail("no boards");
    if (trains < 1) return fail("no departures on any board");
    for (int i = 0; i < data.nBoards; i++) {
      const BoardView& b = data.boards[i];
      if (!b.origin[0] || !b.destShort[0])
        return fail("a board is missing origin / destShort");
      for (int j = 0; j < b.nDeps; j++) {
        const DepView& d = b.deps[j];
        if (d.depEpoch < data.serverNow - 86400 ||
            d.depEpoch > data.serverNow + 3 * 86400)
          return fail("a departure time is not within a few days of `now`");
        if (d.arrEpoch <= d.depEpoch || d.arrEpoch > d.depEpoch + 6 * 3600)
          return fail("an arrival time is not sanely after its departure");
        if (d.leaveEpoch &&
            (d.leaveEpoch >= d.depEpoch || d.leaveEpoch < d.depEpoch - 4 * 3600))
          return fail("a leave-by time is not sanely before its departure");
      }
    }
    if (catchable < 1)
      return fail("no train is still catchable at the response's own `now`");
  }

  GFXcanvas1 canvas(UI_W, UI_H);
  ui_draw(canvas, data, now, NET_CONNECTED, true, page);
  if (!write_canvas(canvas, out)) return 2;
  fprintf(stderr, "wrote %s from %s now=%lld page=%d pages=%d\n", out, path,
          (long long)now, page, ui_page_count(data, now));
  if (check) printf("CONTRACT OK\n");
  return 0;
}

// ---- main -------------------------------------------------------------------

int main(int argc, char** argv) {
  setenv("TZ", "EST5EDT,M3.2.0,M11.1.0", 1);
  tzset();
  if (argc > 1 && !strcmp(argv[1], "--list")) {
    for (int i = 0; i < N_SCENARIOS; i++) puts(SCENARIOS[i].name);
    return 0;
  }
  if (argc > 2 && (!strcmp(argv[1], "--json") || !strcmp(argv[1], "--check"))) {
    const bool check = !strcmp(argv[1], "--check");
    return run_json(argv[2], argc > 3 ? argv[3] : "preview.raw",
                    argc > 4 ? (time_t)atoll(argv[4]) : 0,
                    argc > 5 ? atoi(argv[5]) : 0, check);
  }

  const char* out = argc > 2 ? argv[2] : "preview.raw";
  const char* name = (argc > 4 && argv[4][0]) ? argv[4] : "morning";
  const Scenario* sc = find(name);
  if (!sc) {
    fprintf(stderr, "unknown scenario '%s' (try --list)\n", name);
    return 2;
  }
  const char* s = sc->name;
  int page = (argc > 3 && argv[3][0]) ? atoi(argv[3]) : -1;
  if (page < 0) page = sc->page;

  g_day0 = scenario_day0();
  time_t now = argc > 1 ? (time_t)atoll(argv[1]) : 0;
  if (now == 0) now = at(sc->hour, sc->minute);

  BoardData data{};
  data.ok = true;
  data.fetchedAt = now - 40;
  data.serverNow = now - 40;
  data.lastHttpCode = 200;
  net_state_t net = NET_CONNECTED;
  bool timeValid = true;

  if (!strcmp(s, "tomorrow") || !strcmp(s, "night") ||
      !strcmp(s, "no-trains-tomorrow"))
    build_tomorrow(data);
  else
    build_morning(data);

  if (!strcmp(s, "night-early-train")) {
    // A 4:37 AM train (leave by 4:16): at night it is not counted down.
    clear_live(data);
    DepView& d = data.boards[0].deps[data.boards[0].nDeps++];
    d = data.boards[0].deps[0];
    d.depEpoch = at(4, 37);
    d.arrEpoch = at(5, 51);
    d.leaveEpoch = d.depEpoch - 21 * 60;
    data.fetchedAt = now - 9 * 60;
  } else if (!strcmp(s, "small-hours")) {
    // 2:10 AM: today's board, nothing live yet, last fetched 9 minutes ago.
    clear_live(data);
    data.fetchedAt = now - 9 * 60;
    for (int i = 0; i < data.nBoards; i++)
      data.boards[i].driveSource = DRIVE_EARLIER;
  } else if (!strcmp(s, "night")) {
    data.fetchedAt = now - 11 * 60;
  } else if (!strcmp(s, "leave-at")) {
    clear_live(data);
  } else if (!strcmp(s, "delayed")) {
    lv(data.boards[0].deps[0], LIVE_DELAYED, 14);  // hero
    lv(data.boards[2].deps[0], LIVE_DELAYED, 8);   // row: +8
    lv(data.boards[0].deps[1], LIVE_DELAYED, 2);   // row: too small to flag
    lv(data.boards[1].deps[0], LIVE_DELAYED, 0);   // row: late, amount unknown
  } else if (!strcmp(s, "boarding")) {
    lv(data.boards[0].deps[0], LIVE_BOARDING, 0);
    lv(data.boards[2].deps[0], LIVE_BOARDING, 0);
  } else if (!strcmp(s, "cancelled-first")) {
    lv(data.boards[0].deps[0], LIVE_CANCELLED, 0);  // would have been the hero
    lv(data.boards[1].deps[0], LIVE_CANCELLED, 0);  // and one further down
  } else if (!strcmp(s, "all-cancelled")) {
    for (int i = 0; i < data.nBoards; i++)
      for (int j = 0; j < data.boards[i].nDeps; j++)
        lv(data.boards[i].deps[j], LIVE_CANCELLED, 0);
  } else if (!strcmp(s, "earlier-drive")) {
    for (int i = 0; i < data.nBoards; i++)
      data.boards[i].driveSource = DRIVE_EARLIER;
  } else if (!strcmp(s, "no-drive-time")) {
    for (int i = 0; i < data.nBoards; i++) {
      data.boards[i].driveMin = 0;
      data.boards[i].driveSource = DRIVE_NONE;
      for (int j = 0; j < data.boards[i].nDeps; j++)
        data.boards[i].deps[j].leaveEpoch = 0;
    }
  } else if (!strcmp(s, "alert-short")) {
    snprintf(data.alert, sizeof(data.alert), "M&E: delays of up to 20 minutes");
    data.nAlerts = 1;
  } else if (!strncmp(s, "alert", 5)) {
    snprintf(data.alert, sizeof(data.alert),
             "Morris & Essex Line trains are subject to up to 20-minute delays "
             "in both directions due to an earlier signal problem near Summit.");
    data.nAlerts = 2;
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
  } else if (!strcmp(s, "offline-hours")) {
    // Fetched at 7:05, now 10:30: the later trains are still counting down.
    data.fetchedAt = now - (3 * 3600 + 25 * 60);
    net = NET_DISCONNECTED;
  } else if (!strcmp(s, "offline-long")) {
    // Fetched at 7:05, now 1:30 PM: every train on it has gone.
    data.fetchedAt = now - (6 * 3600 + 25 * 60);
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
  } else if (!strncmp(s, "no-trains", 9)) {
    drop_trains(data);
  }

  GFXcanvas1 canvas(UI_W, UI_H);
  if (!strcmp(s, "updating"))
    ui_draw_notice(canvas, "Updating firmware...",
                   "A new version is being installed over WiFi.",
                   "The board restarts by itself when it's done.");
  else
    ui_draw(canvas, data, now, net, timeValid, page);

  if (!write_canvas(canvas, out)) return 1;
  fprintf(stderr,
          "wrote %s scenario=%s now=%lld page=%d pages=%d trains=%d degraded=%d\n",
          out, s, (long long)now, page, ui_page_count(data, now),
          ui_train_count(data, now), (int)ui_degraded(data, now, timeValid));
  return 0;
}
