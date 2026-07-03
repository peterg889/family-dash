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
// router broadcasts both. WiFi is used only to set the clock over NTP;
// the train schedule itself is baked into the firmware.
#define WIFI_SSID "your-ssid"
#define WIFI_PASS "your-password"
