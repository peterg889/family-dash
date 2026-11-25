// firmware/src/board_api.cpp — see board_api.h.
#include "board_api.h"
#include "config.h"

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

static time_t ms_to_epoch(long long ms) { return (time_t)(ms / 1000); }

// Parsed into here first, so a bad response can never clobber a good board.
static BoardData s_tmp;

static bool fail(BoardData& out, int httpCode, const char* why) {
  out.failStreak++;
  out.lastHttpCode = httpCode;
  Serial.printf("board: fetch failed (%s, http=%d, streak=%d)\n", why, httpCode,
                out.failStreak);
  return false;
}

// Only the fields the screen uses — the response also carries the school-run
// tile, route names, colours etc. that the device never draws.
static void build_filter(JsonDocument& f) {
  f["now"] = true;
  f["mode"] = true;
  f["showLeave"] = true;
  f["headline"] = true;
  f["bufferMin"] = true;
  f["status"]["schedule"]["expired"] = true;
  f["status"]["live"] = true;
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
  d["live"]["track"] = true;
}

bool board_fetch(BoardData& out, time_t now, bool clock_valid) {
  WiFiClientSecure client;
  client.setInsecure();  // skip cert validation — fine for a home device
  HTTPClient http;
  // Bound every phase so one fetch can never outlast the task watchdog
  // (WDT_TIMEOUT_S): connect 6 s + TLS handshake 10 s + response 8 s.
  client.setHandshakeTimeout(10);  // seconds; the default is 2 minutes
  http.setConnectTimeout(6000);
  http.setTimeout(8000);
  if (!http.begin(client, BOARD_API_URL)) return fail(out, 0, "http.begin");
  int code = http.GET();
  if (code != 200) {
    http.end();
    return fail(out, code, "status");
  }
  String payload = http.getString();
  http.end();

  JsonDocument filter;
  build_filter(filter);
  JsonDocument doc;
  DeserializationError err =
      deserializeJson(doc, payload, DeserializationOption::Filter(filter));
  if (err) return fail(out, code, err.c_str());
  // A 200 that isn't a board (an error page, a changed API) must not wipe the
  // board we already have.
  if (!doc["boards"].is<JsonArray>()) return fail(out, code, "no boards[]");

  BoardData& t = s_tmp;
  memset(&t, 0, sizeof(t));
  strlcpy(t.headline, doc["headline"] | "", sizeof(t.headline));
  t.bufferMin = doc["bufferMin"] | 5;

  bool anyLeave = false;
  for (JsonObject b : doc["boards"].as<JsonArray>()) {
    if (t.nBoards >= 6) break;
    BoardView& bv = t.boards[t.nBoards++];
    strlcpy(bv.origin, b["origin"] | "", sizeof(bv.origin));
    strlcpy(bv.destShort, b["destShort"] | "", sizeof(bv.destShort));
    bv.driveMin = b["driveMin"] | 0;
    const char* src = b["driveSource"] | "";
    if (!strcmp(src, "earlier") || !strcmp(src, "typical"))
      bv.driveSource = DRIVE_EARLIER;
    else if (!strcmp(src, "live")) bv.driveSource = DRIVE_LIVE;
    else  // older server: any drive time it sent was a live one
      bv.driveSource = bv.driveMin > 0 ? DRIVE_LIVE : DRIVE_NONE;
    bv.nDeps = 0;
    for (JsonObject dep : b["departures"].as<JsonArray>()) {
      if (bv.nDeps >= 6) break;
      DepView& dv = bv.deps[bv.nDeps++];
      dv.leaveEpoch = ms_to_epoch(dep["leaveByEpochMs"] | 0LL);
      dv.depEpoch = ms_to_epoch(dep["depEpochMs"] | 0LL);
      dv.arrEpoch = ms_to_epoch(dep["arrEpochMs"] | 0LL);
      if (dv.leaveEpoch) anyLeave = true;
      dv.live = LIVE_NONE;
      dv.delayMin = 0;
      dv.track[0] = 0;
      JsonObject lv = dep["live"];
      if (!lv.isNull()) {
        const char* st = lv["state"] | "";
        if (!strcmp(st, "delayed")) dv.live = LIVE_DELAYED;
        else if (!strcmp(st, "cancelled")) dv.live = LIVE_CANCELLED;
        else if (!strcmp(st, "boarding")) dv.live = LIVE_BOARDING;
        else dv.live = LIVE_ON_TIME;
        dv.delayMin = (int16_t)(lv["delayMin"] | 0);
        strlcpy(dv.track, lv["track"] | "", sizeof(dv.track));
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

  // Staleness is measured against the device clock. If that clock isn't set
  // yet, fall back to the server's own "now" so the age is still meaningful
  // once NTP lands.
  time_t serverNow = ms_to_epoch(doc["now"] | 0LL);
  t.fetchedAt = clock_valid ? now : serverNow;
  if (t.fetchedAt == 0) t.fetchedAt = now ? now : 1;  // "fetched" must be != 0
  t.ok = true;
  t.failStreak = 0;
  t.lastHttpCode = code;

  out = t;
  Serial.printf("board: ok, %d boards, mode=%d showLeave=%d expired=%d live=%d\n",
                out.nBoards, (int)out.mode, (int)out.showLeave,
                (int)out.scheduleExpired, (int)out.liveFeed);
  return true;
}
