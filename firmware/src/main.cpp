// firmware/src/main.cpp — Family Dashboard on the CrowPanel 4.2" E-Paper.
//
// Fetches the live family-dash board over WiFi (/api/departures — trains to the
// city, live NJ Transit status and "leave by" times, all computed server-side)
// and renders it as one combined screen on the 400x300 panel. WiFi also sets
// the clock via NTP (for the countdowns between fetches) and carries
// over-the-air firmware updates.
//
// The loop is built to keep itself honest and alive unattended:
//   - a fetch is made at once when WiFi (re)connects or the clock is first set,
//     every 3 min after a good fetch (15 min at night), and 30 s after a failed
//     one;
//   - the screen is re-rendered into memory every few seconds and on the minute,
//     but pushed to the panel only when the picture actually changed — once a
//     minute by day, hardly at all overnight;
//   - the UI is told how old the board is and why, so it never shows a stale or
//     missing board as "no trains" (see ui.cpp); up to 12 trains per board are
//     held, so the countdowns carry on for hours if the network goes away;
//   - a task watchdog, a nightly reboot and a stuck-network reboot recover from
//     hangs without anyone unplugging it.
//
// Serial commands (115200 baud): screenshot / refresh / page [n] / fetch /
// status / settime <epoch> — see firmware/README.md.
#include <Arduino.h>
#include <SPI.h>
#include <esp_idf_version.h>
#include <esp_task_wdt.h>
#include <sys/time.h>

#include "board_api.h"
#include "board_data.h"
#include "buttons.h"
#include "config.h"
#include "display_cfg.h"
#include "net.h"
#include "ota.h"
#include "timekeeper.h"
#include "ui.h"

EinkDisplay display(GxEPD2_420_GYE042A87(EPD_CS, EPD_DC, EPD_RST, EPD_BUSY));

// Full-screen 1-bit canvas: single source of truth for both the panel and
// the screenshot dump.
static GFXcanvas1 canvas(UI_W, UI_H);
static const size_t CANVAS_BYTES = ((UI_W + 7) / 8) * UI_H;  // 50 * 300 = 15000

// What the panel is showing right now, to tell whether a fresh render differs.
static uint8_t pushed[CANVAS_BYTES];
static bool pushed_valid = false;
static uint32_t last_push_ms = 0;
static uint32_t push_count = 0;

// Last-fetched board. Kept across failed fetches so the screen can go on
// showing it — marked with its age — instead of going blank.
static BoardData g_board = {};

static uint32_t last_render_ms = 0;
static long last_render_minute = -1;
static bool dirty = true;  // something changed: render now, don't wait

// Paging through later trains with the up/down toggle.
static int g_page = 0;
static uint32_t page_set_ms = 0;

// Fetch scheduling.
static uint32_t last_attempt_ms = 0;  // last fetch attempt (good or bad)
static uint32_t last_ok_ms = 0;       // last good fetch (0 = none since boot)
static uint32_t fetch_wait_ms = FETCH_RETRY_MS;  // gap before the next attempt
static bool fetch_now = true;  // fetch as soon as WiFi allows
static net_state_t prev_net = NET_DISCONNECTED;
static bool prev_time_valid = false;
static uint32_t last_connected_ms = 0;  // last time WiFi was seen connected
static bool clock_from_server = false;  // clock was set from the API, not NTP

// ---- watchdog ---------------------------------------------------------------

static void wdt_begin() {
#if ESP_IDF_VERSION_MAJOR >= 5
  // The core already runs the task watchdog (5 s, idle task only): retune it
  // and add this task, so a wedged loop() resets the chip.
  esp_task_wdt_config_t cfg = {
      .timeout_ms = WDT_TIMEOUT_S * 1000U,
      .idle_core_mask = 1U << 0,
      .trigger_panic = true,
  };
  if (esp_task_wdt_reconfigure(&cfg) != ESP_OK) esp_task_wdt_init(&cfg);
#else
  esp_task_wdt_init(WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);  // the Arduino loop task
}

static inline void wdt_feed() { esp_task_wdt_reset(); }

static void restart(const char* why) {
  Serial.printf("RESTART: %s (uptime %lus)\n", why,
                (unsigned long)(millis() / 1000));
  Serial.flush();
  delay(100);
  ESP.restart();
}

// ---- fetch ------------------------------------------------------------------

static bool is_night() { return time_valid() && ui_is_night(time_now()); }

// One fetch attempt (only when WiFi is up). Returns true on a good fetch.
static bool fetch_board() {
  fetch_now = false;
  if (net_state() != NET_CONNECTED) return false;
  wdt_feed();
  bool ok = board_fetch(g_board, time_now(), time_valid());
  wdt_feed();
  last_attempt_ms = millis();
  if (ok) {
    last_ok_ms = last_attempt_ms;
    // No clock yet (NTP unreachable)? The server just told us the time — good
    // to within the edge cache's few seconds, and NTP corrects it when it can.
    if (!time_valid() && g_board.serverNow > 1704067200) {  // sanity: >= 2024
      struct timeval tv = {g_board.serverNow, 0};
      settimeofday(&tv, nullptr);
      clock_from_server = true;
      Serial.printf("Time: set from the server (%lld)\n",
                    (long long)g_board.serverNow);
    }
    dirty = true;
  }
  fetch_wait_ms = !ok ? FETCH_RETRY_MS
                      : (is_night() ? FETCH_INTERVAL_NIGHT_MS : FETCH_INTERVAL_MS);
  return ok;
}

// ---- render -----------------------------------------------------------------

static void push_canvas(bool full) {
  wdt_feed();
  display.setFullWindow();
  display.fillScreen(GxEPD_WHITE);
  // Canvas bit == 1 → ink → black; 0-bits left as the white fill.
  display.drawBitmap(0, 0, canvas.getBuffer(), UI_W, UI_H, GxEPD_BLACK);
  display.display(!full);  // display(false)=full refresh, display(true)=partial
  wdt_feed();
  memcpy(pushed, canvas.getBuffer(), CANVAS_BYTES);
  pushed_valid = true;
  last_push_ms = millis();
  push_count++;
}

// Draw the board into the canvas; push it to the panel (a flashing full
// refresh) only if it differs from what the panel already shows, or `force`.
// Returns true when it pushed.
static bool render(bool force) {
  const time_t now = time_now();
  const int pages = ui_page_count(g_board, now);
  if (g_page >= pages) g_page = pages - 1;
  if (g_page < 0) g_page = 0;

  ui_draw(canvas, g_board, now, net_state(), time_valid(), g_page);
  last_render_ms = millis();
  last_render_minute = (long)(now / 60);
  dirty = false;
  if (!force && pushed_valid &&
      memcmp(pushed, canvas.getBuffer(), CANVAS_BYTES) == 0)
    return false;
  push_canvas(true);
  return true;
}

// ---- OTA hooks --------------------------------------------------------------

static void ota_started() {
  ui_draw_notice(canvas, "Updating firmware...",
                 "A new version is being installed over WiFi.",
                 "The board restarts by itself when it's done.");
  push_canvas(false);  // fast partial update — don't keep the uploader waiting
}

static void ota_aborted() { render(true); }

// ---- serial commands --------------------------------------------------------

static void send_screenshot() {
  Serial.printf("SCREENSHOT_START %d %d %u\n", UI_W, UI_H,
                (unsigned)CANVAS_BYTES);
  Serial.flush();
  Serial.write(canvas.getBuffer(), CANVAS_BYTES);
  Serial.flush();
  Serial.println();
  Serial.println("SCREENSHOT_END");
}

// One JSON line describing the device's health, for QA over serial.
static void send_status() {
  const uint32_t up = millis();
  const time_t now = time_now();
  const long okAge = last_ok_ms ? (long)((up - last_ok_ms) / 1000) : -1;
  const long boardAge =
      (g_board.fetchedAt && time_valid()) ? (long)(now - g_board.fetchedAt) : -1;
  static const char* const NET[] = {"disconnected", "connecting", "connected"};
  Serial.printf(
      "{\"app\":\"family-dash-eink\",\"build\":\"%s %s\",\"uptime_s\":%lu,"
      "\"net\":\"%s\",\"ip\":\"%s\",\"rssi\":%d,\"time_valid\":%s,"
      "\"clock_from_server\":%s,\"epoch\":%lld,\"night\":%s,"
      "\"heap\":%u,\"min_heap\":%u,\"psram\":%u,"
      "\"last_ok_s\":%ld,\"board_age_s\":%ld,\"http\":%d,\"fail_streak\":%d,"
      "\"next_fetch_s\":%ld,\"boards\":%d,\"trains\":%d,\"mode\":%d,"
      "\"show_leave\":%s,\"expired\":%s,\"live_feed\":%d,\"alerts\":%d,"
      "\"degraded\":%s,\"page\":%d,\"pages\":%d,\"pushes\":%lu,"
      "\"last_push_s\":%ld,\"ota\":%s}\n",
      __DATE__, __TIME__, (unsigned long)(up / 1000), NET[net_state()],
      net_ip(), net_rssi(), time_valid() ? "true" : "false",
      clock_from_server ? "true" : "false", (long long)now,
      is_night() ? "true" : "false", (unsigned)ESP.getFreeHeap(),
      (unsigned)ESP.getMinFreeHeap(), (unsigned)ESP.getFreePsram(), okAge,
      boardAge, g_board.lastHttpCode, g_board.failStreak,
      fetch_now ? 0L
                : (long)(((long long)fetch_wait_ms -
                          (long long)(up - last_attempt_ms)) /
                         1000),
      g_board.nBoards, ui_train_count(g_board, now), (int)g_board.mode,
      g_board.showLeave ? "true" : "false",
      g_board.scheduleExpired ? "true" : "false", (int)g_board.liveFeed,
      g_board.nAlerts,
      ui_degraded(g_board, now, time_valid()) ? "true" : "false", g_page,
      ui_page_count(g_board, now), (unsigned long)push_count,
      pushed_valid ? (long)((up - last_push_ms) / 1000) : -1L,
      ota_enabled() ? "true" : "false");
}

static void set_page(int page) {
  const int pages = ui_page_count(g_board, time_now());
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;
  g_page = page;
  page_set_ms = millis();
  dirty = true;
}

static char cmd_buf[32];
static uint8_t cmd_len = 0;

static void check_serial_cmd() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      cmd_buf[cmd_len] = 0;
      if (strcmp(cmd_buf, "screenshot") == 0) send_screenshot();
      else if (strcmp(cmd_buf, "status") == 0) send_status();
      else if (strcmp(cmd_buf, "refresh") == 0) render(true);
      else if (strcmp(cmd_buf, "page") == 0 || strcmp(cmd_buf, "screen") == 0) {
        // Next page of later trains, wrapping back to the first.
        const int pages = ui_page_count(g_board, time_now());
        set_page((g_page + 1) % pages);
        render(true);
      } else if (strncmp(cmd_buf, "page ", 5) == 0) {
        set_page(atoi(cmd_buf + 5));
        render(true);
      } else if (strcmp(cmd_buf, "fetch") == 0) {
        fetch_board();
        render(true);
      } else if (strncmp(cmd_buf, "settime ", 8) == 0) {
        // QA helper: inject a known wall-clock epoch (seconds) and redraw.
        struct timeval tv = {(time_t)strtoll(cmd_buf + 8, nullptr, 10), 0};
        settimeofday(&tv, nullptr);
        Serial.printf("time set to %lld\n", (long long)tv.tv_sec);
        render(true);
      }
      cmd_len = 0;
    } else if (cmd_len < sizeof(cmd_buf) - 1) {
      cmd_buf[cmd_len++] = c;
    }
  }
}

// ---- self-healing -----------------------------------------------------------

static void self_heal() {
  const uint32_t up = millis();

  // Nightly reboot, while nobody is looking.
  if (up > NIGHTLY_MIN_UPTIME_MS && time_valid()) {
    time_t t = time_now();
    struct tm tm;
    localtime_r(&t, &tm);
    if (tm.tm_hour == NIGHTLY_REBOOT_HOUR &&
        tm.tm_min >= NIGHTLY_REBOOT_MINUTE &&
        tm.tm_min < NIGHTLY_REBOOT_MINUTE + 10)
      restart("nightly");
  }

  if (up < STUCK_MIN_UPTIME_MS) return;  // at most one such restart an hour
  if (net_state() == NET_CONNECTED) {
    // WiFi claims to be up, yet no HTTP exchange has completed for a long
    // time: the network stack is wedged. (If the server is answering — even
    // with errors — the device is fine and a reboot would only throw away the
    // board it's still showing, so that case is left alone.)
    if (up - last_ok_ms > STUCK_RESTART_MS && g_board.failStreak > 0 &&
        g_board.lastHttpCode <= 0)
      restart("fetches stuck with WiFi up");
  } else if (up - last_connected_ms > STUCK_RESTART_MS) {
    restart("WiFi won't reconnect");
  }
}

// ---- lifecycle --------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  delay(200);
  Serial.println("{\"ready\":true,\"app\":\"family-dash-eink\"}");

  wdt_begin();

  // Power the E-Paper panel BEFORE init (critical for this board).
  pinMode(EPD_PWR, OUTPUT);
  digitalWrite(EPD_PWR, HIGH);
  delay(10);

  // ESP32-S3 default SPI pins are not the panel pins — remap is mandatory.
  SPI.begin(EPD_SCK, -1, EPD_MOSI, EPD_CS);
  display.init(115200, true, 50, false);
  display.setRotation(0);  // native 400x300 landscape
  wdt_feed();

  buttons_init();
  ota_init(ota_started, ota_aborted);

  net_init(WIFI_CONNECT_TIMEOUT_MS);
  wdt_feed();
  time_begin();

  // Give NTP a moment so the first frame's countdowns are right.
  uint32_t deadline = millis() + 8000;
  while (!time_valid() && millis() < deadline) {
    delay(200);
    net_tick();
    wdt_feed();
  }
  Serial.printf("Time valid: %s\n", time_valid() ? "yes" : "no");

  last_connected_ms = millis();

  fetch_board();  // first fetch (skipped if WiFi isn't up yet); may set the clock
  prev_net = net_state();
  prev_time_valid = time_valid();
  render(true);  // first draw is always pushed
  Serial.println("Dashboard ready.");
}

void loop() {
  wdt_feed();
  net_tick();
  ota_tick();
  check_serial_cmd();

  // Fetch at once when WiFi comes (back) up or the clock is first set, rather
  // than waiting out the timer; either also changes what the screen says.
  const net_state_t ns = net_state();
  const bool tv = time_valid();
  if (ns == NET_CONNECTED) {
    last_connected_ms = millis();
    if (prev_net != NET_CONNECTED) fetch_now = true;
  }
  if (ns != prev_net) dirty = true;
  if (tv && !prev_time_valid) {
    fetch_now = true;
    dirty = true;
  }
  prev_net = ns;
  prev_time_valid = tv;

  // Up/down toggle pages through later trains; it goes back by itself.
  BtnEvent be = buttons_poll();
  if (be != BTN_NONE) {
    set_page(g_page + (be == BTN_DOWN ? 1 : -1));
    Serial.printf("BTN %s -> page %d\n", be == BTN_DOWN ? "DOWN" : "UP", g_page);
  }
  if (g_page != 0 && millis() - page_set_ms >= PAGE_RETURN_MS) set_page(0);

  // Refetch: 3 min after a good fetch (15 at night), 30 s after a failed one.
  if (ns == NET_CONNECTED &&
      (fetch_now || millis() - last_attempt_ms >= fetch_wait_ms)) {
    fetch_board();
  }

  // Re-render when something changed, on the minute (the clock and every
  // countdown tick then), and every few seconds as a backstop. The panel is
  // only touched if the picture is different.
  const bool minute_turned =
      tv && (long)(time_now() / 60) != last_render_minute;
  if (dirty || minute_turned ||
      millis() - last_render_ms >= RENDER_INTERVAL_MS) {
    render(false);
  }

  self_heal();
  delay(20);
}
