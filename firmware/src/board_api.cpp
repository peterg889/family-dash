// firmware/src/board_api.cpp — see board_api.h.
#include "board_api.h"
#include "config.h"

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>

static time_t ms_to_epoch(long long ms) { return (time_t)(ms / 1000); }

bool board_fetch(BoardData& out, time_t now) {
  WiFiClientSecure client;
  client.setInsecure();  // skip cert validation — fine for a home device
  HTTPClient http;
  http.setConnectTimeout(8000);
  http.setTimeout(8000);
  if (!http.begin(client, BOARD_API_URL)) {
    Serial.println("board: http.begin failed");
    return false;
  }
  int code = http.GET();
  if (code != 200) {
    Serial.printf("board: GET %d\n", code);
    http.end();
    return false;
  }
  String payload = http.getString();
  http.end();

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, payload);
  if (err) {
    Serial.printf("board: json err %s\n", err.c_str());
    return false;
  }

  strlcpy(out.headline, doc["headline"] | "", sizeof(out.headline));
  out.bufferMin = doc["bufferMin"] | 5;

  out.nBoards = 0;
  for (JsonObject b : doc["boards"].as<JsonArray>()) {
    if (out.nBoards >= 6) break;
    BoardView& bv = out.boards[out.nBoards++];
    strlcpy(bv.origin, b["origin"] | "", sizeof(bv.origin));
    strlcpy(bv.destShort, b["destShort"] | "", sizeof(bv.destShort));
    bv.driveMin = b["driveMin"] | 0;
    bv.nDeps = 0;
    for (JsonObject dep : b["departures"].as<JsonArray>()) {
      if (bv.nDeps >= 6) break;
      DepView& dv = bv.deps[bv.nDeps++];
      dv.leaveEpoch = ms_to_epoch(dep["leaveByEpochMs"] | 0LL);
      dv.depEpoch = ms_to_epoch(dep["depEpochMs"] | 0LL);
      dv.arrEpoch = ms_to_epoch(dep["arrEpochMs"] | 0LL);
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

  out.ok = true;
  out.fetchedAt = now;
  Serial.printf("board: ok, %d boards, headline='%s'\n", out.nBoards,
                out.headline);
  return true;
}
