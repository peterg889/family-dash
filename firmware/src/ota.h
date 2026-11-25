// firmware/src/ota.h — over-the-air firmware updates (ArduinoOTA / espota).
//
// Enabled only when wifi_config.h defines OTA_PASSWORD; without it the board
// does not listen for updates at all. Upload with ../../flash-ota.sh.
#pragma once

// Register callbacks. `on_start` runs just before an update begins (draw an
// "Updating" screen); `on_abort` runs if it fails (redraw the board). Safe to
// call before WiFi is up.
void ota_init(void (*on_start)(void), void (*on_abort)(void));

// Call every loop: starts the listener once WiFi is connected, then services
// it. An update, once started, runs to completion inside this call and ends
// in a reboot.
void ota_tick(void);

bool ota_enabled(void);
