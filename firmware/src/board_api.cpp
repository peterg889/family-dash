// firmware/src/board_api.cpp — see board_api.h.
#include "board_api.h"
#include "board_parse.h"
#include "config.h"

#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

static bool fail(BoardData& out, int httpCode, const char* why) {
  out.failStreak++;
  out.lastHttpCode = httpCode;
  Serial.printf("board: fetch failed (%s, http=%d, streak=%d)\n", why, httpCode,
                out.failStreak);
  return false;
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

  const char* why = "parse";
  if (!board_parse(payload.c_str(), payload.length(), out, now, clock_valid,
                   &why))
    return fail(out, code, why);

  out.lastHttpCode = code;
  int trains = 0;
  for (int i = 0; i < out.nBoards; i++) trains += out.boards[i].nDeps;
  Serial.printf(
      "board: ok, %u bytes, %d boards, %d trains, mode=%d showLeave=%d "
      "expired=%d live=%d alerts=%d\n",
      (unsigned)payload.length(), out.nBoards, trains, (int)out.mode,
      (int)out.showLeave, (int)out.scheduleExpired, (int)out.liveFeed,
      out.nAlerts);
  return true;
}
