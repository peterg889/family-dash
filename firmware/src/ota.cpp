// firmware/src/ota.cpp — see ota.h.
#include "ota.h"

#include <Arduino.h>
#include <esp_task_wdt.h>

#include "config.h"
#include "net.h"
#include "wifi_config.h"

#ifdef OTA_PASSWORD

#include <ArduinoOTA.h>

static void (*s_on_start)(void) = nullptr;
static void (*s_on_abort)(void) = nullptr;
static bool s_started = false;

void ota_init(void (*on_start)(void), void (*on_abort)(void)) {
  s_on_start = on_start;
  s_on_abort = on_abort;
}

static void start_listener() {
  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() {
    Serial.println("OTA: update starting");
    if (s_on_start) s_on_start();
  });
  // The whole upload happens inside ArduinoOTA.handle(), so loop() doesn't
  // come round to feed the watchdog — feed it from the progress callback.
  ArduinoOTA.onProgress([](unsigned int, unsigned int) {
    esp_task_wdt_reset();
  });
  ArduinoOTA.onEnd([]() { Serial.println("OTA: done, rebooting"); });
  ArduinoOTA.onError([](ota_error_t e) {
    Serial.printf("OTA: failed (error %u)\n", (unsigned)e);
    if (s_on_abort) s_on_abort();
  });
  ArduinoOTA.begin();
  s_started = true;
  Serial.printf("OTA: listening as %s.local\n", OTA_HOSTNAME);
}

void ota_tick(void) {
  if (net_state() != NET_CONNECTED) return;
  if (!s_started) start_listener();
  ArduinoOTA.handle();
}

bool ota_enabled(void) { return true; }

#else  // no OTA_PASSWORD: updates over WiFi are off

void ota_init(void (*)(void), void (*)(void)) {}
void ota_tick(void) {}
bool ota_enabled(void) { return false; }

#endif
