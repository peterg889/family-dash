// firmware/src/wifi_config.h
//
// LOCAL CONFIG — gitignored. Copy this file alongside as `wifi_config.h`
// and fill in your network. The build fails to compile without it.
//
//     cp firmware/src/wifi_config.example.h firmware/src/wifi_config.h
//     $EDITOR firmware/src/wifi_config.h
//
#pragma once

// 2.4 GHz WPA2 network the board joins. SSIDs are case-sensitive.
// The ESP32-S3 cannot join 5 GHz networks — use the 2.4 GHz SSID if your
// router broadcasts both. Everything the board shows arrives over WiFi: the
// train board (fetched from the family-dash web app) and the clock (NTP).
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"

// Password for over-the-air firmware updates (../../flash-ota.sh). Pick any
// long random string, e.g. `openssl rand -hex 12`. Anyone on your WiFi who
// knows it can reflash the board, so keep it out of git (this file's real
// copy is gitignored). Leave it undefined to turn OTA updates off entirely —
// the board then only updates over USB (../../flash-mac.sh).
// #define OTA_PASSWORD "change-me-to-a-long-random-string"
