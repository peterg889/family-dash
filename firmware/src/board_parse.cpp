// firmware/src/board_parse.cpp — see board_parse.h.
//
// Every field read here is listed in ../api-fields.json; the server's tests
// assert each of them is present in its response. Change one, change both.
#include "board_parse.h"

#include <ArduinoJson.h>

#include <stdio.h>
#include <string.h>

static time_t ms_to_epoch(long long ms) { return (time_t)(ms / 1000); }

static void copy(char* dst, size_t n, const char* src) {
  snprintf(dst, n, "%s", src ? src : "");
}

// Parsed into here first, so a bad response can never clobber a good board.
static BoardData s_tmp;

// Only the fields the screen uses — the response also carries the school-run
// tile, route names, colours, tracks etc. that the device never draws.
static void build_filter(JsonDocument& f) {
  f["now"] = true;
  f["mode"] = true;
  f["showLeave"] = true;
  f["headline"] = true;
  f["status"]["schedule"]["expired"] = true;
  f["status"]["live"] = true;
  f["alerts"][0]["text"] = true;
  f["alerts"][0]["urgent"] = true;
  JsonObject b = f["boards"][0].to<JsonObject>();
  b["origin"] = true;
  b["destShort"] = true;
  b["driveMin"] = true;
  b["driveSource"] = true;
  JsonObject d = b["departures"][0].to<JsonObject>();
  d["leaveByEpochMs"] = true;
  d["depEpochMs"] = true;
  d["arrEpochMs"] = true;
  d["live"]["state"] = true;
  d["live"]["delayMin"] = true;
}

bool board_parse(const char* json, size_t len, BoardData& out, time_t now,
                 bool clock_valid, const char** why) {
  auto fail = [&](const char* reason) {
    if (why) *why = reason;
    return false;
  };

  JsonDocument filter;
  build_filter(filter);
  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, json, len, DeserializationOption::Filter(filter));
  if (err) return fail(err.c_str());
  // A 200 that isn't a board (an error page, a changed API) must not wipe the
  // board we already have.
  if (!doc["boards"].is<JsonArray>()) return fail("no boards[]");

  BoardData& t = s_tmp;
  memset(&t, 0, sizeof(t));
  copy(t.headline, sizeof(t.headline), doc["headline"] | "");

  bool anyLeave = false;
  for (JsonObject b : doc["boards"].as<JsonArray>()) {
    if (t.nBoards >= MAX_BOARDS) break;
    BoardView& bv = t.boards[t.nBoards++];
    copy(bv.origin, sizeof(bv.origin), b["origin"] | "");
    copy(bv.destShort, sizeof(bv.destShort), b["destShort"] | "");
    bv.driveMin = b["driveMin"] | 0;
    const char* src = b["driveSource"] | "";
    if (!strcmp(src, "earlier") || !strcmp(src, "typical"))
      bv.driveSource = DRIVE_EARLIER;
    else if (!strcmp(src, "live")) bv.driveSource = DRIVE_LIVE;
    else  // older server: any drive time it sent was a live one
      bv.driveSource = bv.driveMin > 0 ? DRIVE_LIVE : DRIVE_NONE;
    bv.nDeps = 0;
    for (JsonObject dep : b["departures"].as<JsonArray>()) {
      if (bv.nDeps >= MAX_DEPS) break;
      const long long depMs = dep["depEpochMs"] | 0LL;
      if (depMs <= 0) continue;  // a train with no departure time is no train
      DepView& dv = bv.deps[bv.nDeps++];
      dv.leaveEpoch = ms_to_epoch(dep["leaveByEpochMs"] | 0LL);
      dv.depEpoch = ms_to_epoch(depMs);
      dv.arrEpoch = ms_to_epoch(dep["arrEpochMs"] | 0LL);
      if (dv.leaveEpoch) anyLeave = true;
      dv.live = LIVE_NONE;
      dv.delayMin = 0;
      JsonObject lv = dep["live"];
      if (!lv.isNull()) {
        const char* st = lv["state"] | "";
        if (!strcmp(st, "delayed")) dv.live = LIVE_DELAYED;
        else if (!strcmp(st, "cancelled")) dv.live = LIVE_CANCELLED;
        else if (!strcmp(st, "boarding")) dv.live = LIVE_BOARDING;
        else dv.live = LIVE_ON_TIME;
        dv.delayMin = (int16_t)(lv["delayMin"] | 0);
      }
    }
  }

  // Whether the big number means "leave the house" is the server's call. Only
  // an older server (no showLeave field) makes us infer it from the data.
  if (doc["showLeave"].is<bool>()) t.showLeave = doc["showLeave"].as<bool>();
  else t.showLeave = anyLeave;

  const char* mode = doc["mode"] | "";
  if (!strcmp(mode, "evening")) t.mode = MODE_EVENING;
  else if (!strcmp(mode, "next-morning")) t.mode = MODE_NEXT_MORNING;
  else if (!strcmp(mode, "morning")) t.mode = MODE_MORNING;
  else if (strstr(t.headline, "tomorrow")) t.mode = MODE_NEXT_MORNING;
  else t.mode = t.showLeave ? MODE_MORNING : MODE_EVENING;

  t.scheduleExpired = doc["status"]["schedule"]["expired"] | false;
  const char* lf = doc["status"]["live"] | "";
  if (!strcmp(lf, "ok")) t.liveFeed = FEED_OK;
  else if (!strcmp(lf, "down")) t.liveFeed = FEED_DOWN;
  else if (!strcmp(lf, "off")) t.liveFeed = FEED_OFF;
  else t.liveFeed = FEED_UNKNOWN;

  // Service alerts: the sign has one line, so it only takes alerts the server
  // marks as affecting trains (delays, cancellations, suspensions) — general
  // notices stay on the web page. Keep the first such alert's text.
  for (JsonObject a : doc["alerts"].as<JsonArray>()) {
    const char* text = a["text"] | "";
    if (!text[0]) continue;
    if (!(a["urgent"] | false)) continue;
    if (t.nAlerts == 0) copy(t.alert, sizeof(t.alert), text);
    t.nAlerts++;
  }

  // Staleness is measured against the device clock. If that clock isn't set
  // yet, fall back to the server's own "now" so the age is still meaningful
  // once the clock lands.
  t.serverNow = ms_to_epoch(doc["now"] | 0LL);
  t.fetchedAt = clock_valid ? now : t.serverNow;
  if (t.fetchedAt == 0) t.fetchedAt = now ? now : 1;  // "fetched" must be != 0
  t.ok = true;
  t.failStreak = 0;
  t.lastHttpCode = out.lastHttpCode;

  out = t;
  return true;
}
