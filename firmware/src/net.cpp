// firmware/src/net.cpp — WiFi association + auto-reconnect.
// Adapted (simplified) from the Clawdmeter net module: no server-URL
// resolution, since the schedule is baked in and WiFi only feeds NTP.
#include "net.h"
#include "wifi_config.h"

#include <Arduino.h>
#include <WiFi.h>

static net_state_t s_state = NET_DISCONNECTED;
static uint32_t s_connect_started_ms = 0;
static char s_ip_buf[16] = "---";

#define WIFI_RETRY_INTERVAL_MS 10000

static void start_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  s_connect_started_ms = millis();
  s_state = NET_CONNECTING;
  Serial.printf("WiFi: connecting to '%s'\n", WIFI_SSID);
}

static void capture_ip() {
  IPAddress ip = WiFi.localIP();
  snprintf(s_ip_buf, sizeof(s_ip_buf), "%u.%u.%u.%u", ip[0], ip[1], ip[2], ip[3]);
}

void net_init(uint32_t timeout_ms) {
  start_wifi();
  uint32_t deadline = millis() + timeout_ms;
  while (WiFi.status() != WL_CONNECTED && millis() < deadline) {
    delay(50);
  }
  if (WiFi.status() == WL_CONNECTED) {
    capture_ip();
    s_state = NET_CONNECTED;
    Serial.printf("WiFi: connected, ip=%s\n", s_ip_buf);
  } else {
    Serial.printf("WiFi: not up after %lums, will keep retrying\n",
                  (unsigned long)timeout_ms);
  }
}

void net_tick(void) {
  wl_status_t ws = WiFi.status();
  if (ws == WL_CONNECTED) {
    if (s_state != NET_CONNECTED) {
      capture_ip();
      s_state = NET_CONNECTED;
      Serial.printf("WiFi: connected, ip=%s\n", s_ip_buf);
    }
    return;
  }
  if (s_state == NET_CONNECTED) {
    Serial.printf("WiFi: lost (status=%d)\n", (int)ws);
    s_state = NET_DISCONNECTED;
    strcpy(s_ip_buf, "---");
  }
  if (s_state != NET_CONNECTING ||
      (millis() - s_connect_started_ms) > WIFI_RETRY_INTERVAL_MS) {
    start_wifi();
  }
}

net_state_t net_state(void) { return s_state; }
const char* net_ssid(void) { return WIFI_SSID; }
const char* net_ip(void) { return s_ip_buf; }
