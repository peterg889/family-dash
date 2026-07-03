// firmware/src/main.cpp — Family Dashboard on the CrowPanel 4.2" E-Paper.
//
// Fetches the live family-dash board over WiFi (/api/departures — departures
// plus traffic-aware "leave by" times computed server-side via Google Maps)
// and renders it on the 400x300 panel. WiFi also sets the clock via NTP (for
// the live "in N min" countdowns between fetches). Serial command "screenshot"
// dumps the 1-bit framebuffer for host-side QA (see screenshot.sh).
#include <Arduino.h>
#include <SPI.h>
#include <sys/time.h>

#include "board_api.h"
#include "board_data.h"
#include "buttons.h"
#include "config.h"
#include "display_cfg.h"
#include "net.h"
#include "timekeeper.h"
#include "ui.h"

EinkDisplay display(GxEPD2_420_GYE042A87(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));

// Full-screen 1-bit canvas: single source of truth for both the panel and
// the screenshot dump.
static GFXcanvas1 canvas(UI_W, UI_H);
static const size_t CANVAS_BYTES = ((UI_W + 7) / 8) * UI_H;  // 50 * 300 = 15000

// Last-fetched board (kept across refreshes so we can show stale data if a
// fetch fails).
static BoardData g_board = {};

static uint32_t last_render_ms = 0;
static uint32_t last_fetch_ms = 0;
static UiScreen g_screen = SCREEN_MORRISTOWN;

// ---- fetch + render ---------------------------------------------------------

static void fetch_board() {
  if (net_state() == NET_CONNECTED) board_fetch(g_board, time_now());
}

// Draw the current board into the canvas and push it to the panel. `full`
// forces a flashing full refresh (de-ghost); otherwise a fast partial update.
static void render_and_push(bool full) {
  ui_draw(canvas, g_board, time_now(), net_state(), time_valid(), g_screen);

  display.setFullWindow();
  display.fillScreen(GxEPD_WHITE);
  // Canvas bit == 1 → ink → black; 0-bits left as the white fill.
  display.drawBitmap(0, 0, canvas.getBuffer(), UI_W, UI_H, GxEPD_BLACK);
  display.display(!full);  // display(false)=full refresh, display(true)=partial
}

// ---- screenshot (serial) ----------------------------------------------------

static void send_screenshot() {
  Serial.printf("SCREENSHOT_START %d %d %u\n", UI_W, UI_H,
                (unsigned)CANVAS_BYTES);
  Serial.flush();
  Serial.write(canvas.getBuffer(), CANVAS_BYTES);
  Serial.flush();
  Serial.println();
  Serial.println("SCREENSHOT_END");
}

static char cmd_buf[32];
static uint8_t cmd_len = 0;

static void check_serial_cmd() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmd_buf[cmd_len] = 0;
      if (strcmp(cmd_buf, "screenshot") == 0) send_screenshot();
      else if (strcmp(cmd_buf, "refresh") == 0) render_and_push(true);
      else if (strcmp(cmd_buf, "screen") == 0) {
        g_screen = (UiScreen)((g_screen + 1) % SCREEN_COUNT);
        render_and_push(true);
      } else if (strcmp(cmd_buf, "fetch") == 0) {
        fetch_board();
        render_and_push(true);
      } else if (strncmp(cmd_buf, "settime ", 8) == 0) {
        // QA helper: inject a known wall-clock epoch (seconds) and redraw.
        struct timeval tv = {(time_t)strtoll(cmd_buf + 8, nullptr, 10), 0};
        settimeofday(&tv, nullptr);
        Serial.printf("time set to %lld\n", (long long)tv.tv_sec);
        render_and_push(true);
      }
      cmd_len = 0;
    } else if (cmd_len < sizeof(cmd_buf) - 1) {
      cmd_buf[cmd_len++] = c;
    }
  }
}

// ---- lifecycle --------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("{\"ready\":true,\"app\":\"family-dash-eink\"}");

  // Power the E-Paper panel BEFORE init (critical for this board).
  pinMode(EPD_PWR, OUTPUT);
  digitalWrite(EPD_PWR, HIGH);
  delay(10);

  // ESP32-S3 default SPI pins are not the panel pins — remap is mandatory.
  SPI.begin(EPD_SCK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 50, false);
  display.setRotation(0);  // native 400x300 landscape

  buttons_init();

  net_init(WIFI_CONNECT_TIMEOUT_MS);
  time_begin();

  // Give NTP a moment so the first frame's countdowns are right.
  uint32_t deadline = millis() + 8000;
  while (!time_valid() && millis() < deadline) {
    delay(200);
    net_tick();
  }
  Serial.printf("Time valid: %s\n", time_valid() ? "yes" : "no");

  fetch_board();          // first fetch
  render_and_push(true);  // first draw (SCREEN_LEAVE) is a full refresh
  last_render_ms = millis();
  last_fetch_ms = millis();
  Serial.println("Dashboard ready.");
}

void loop() {
  net_tick();
  check_serial_cmd();

  // Up/down toggle switches station; also resets the auto-rotate timer.
  BtnEvent be = buttons_poll();
  if (be != BTN_NONE) {
    if (be == BTN_DOWN)
      g_screen = (UiScreen)((g_screen + 1) % SCREEN_COUNT);
    else
      g_screen = (UiScreen)((g_screen + SCREEN_COUNT - 1) % SCREEN_COUNT);
    Serial.printf("BTN %s -> screen %d\n", be == BTN_DOWN ? "DOWN" : "UP",
                  (int)g_screen);
    render_and_push(true);
    last_render_ms = millis();
  }

  // Refetch the board occasionally (traffic + departures change slowly).
  if (millis() - last_fetch_ms >= FETCH_INTERVAL_MS) {
    fetch_board();
    last_fetch_ms = millis();
  }

  // Rotate to the next screen (full refresh — the layouts differ, and this
  // also refreshes the countdowns from the local clock).
  if (millis() - last_render_ms >= ROTATE_INTERVAL_MS) {
    g_screen = (UiScreen)((g_screen + 1) % SCREEN_COUNT);
    render_and_push(true);
    last_render_ms = millis();
  }

  delay(20);
}
