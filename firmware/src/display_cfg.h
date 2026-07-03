// firmware/src/display_cfg.h — Elecrow CrowPanel ESP32 E-Paper 4.2" pin map.
//
// Panel: SSD1683 controller, 400x300 B/W, 3-wire SPI (write-only, no MISO).
// Board: ESP32-S3-WROOM-1-N8R8, CH340 USB-UART.
//
// GPIO7 is the panel power-enable and MUST be driven HIGH before display.init()
// or the SSD1683 gets no power and the screen stays blank. This is the #1
// gotcha for this board.
#pragma once

#include <GxEPD2_BW.h>

#define EPD_PWR 7    // panel power enable — HIGH before init (critical)
#define EPD_SCK 12   // SPI clock
#define EPD_MOSI 11  // SPI data (DIN); panel is write-only, MISO = -1
#define EPD_CS 45
#define EPD_DC 46
#define EPD_RST 47
#define EPD_BUSY 48

// Full-height buffer (HEIGHT == panel height) → single page, supports the
// draw-then-display() API used for full vs. fast-partial refresh.
using EinkDisplay =
    GxEPD2_BW<GxEPD2_420_GYE042A87, GxEPD2_420_GYE042A87::HEIGHT>;

extern EinkDisplay display;
