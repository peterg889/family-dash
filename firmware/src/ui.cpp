// firmware/src/ui.cpp — renders the live family-dash board (board_data.h).
//
// One screen per home station (Morristown / Bernardsville). The station name is
// the screen's identity; the "leave in" countdown for its next catchable train
// is the one hero; a short "up next" list sits quietly below. Words in a sans
// face, times in a monospace face. 400x300, 1-bit.
#include "ui.h"

#include <Fonts/FreeSansBold24pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <cstdio>
#include <cstring>

static const uint16_t INK = 1;
static const uint16_t BG = 0;

static const int HEADER_H = 42;
static const int PAD_L = 14;

static const char* const STATION_NAME[SCREEN_COUNT] = {"Morristown",
                                                       "Bernardsville"};

// --- text helpers -----------------------------------------------------------

static void draw_left(GFXcanvas1& c, const GFXfont* f, int x, int y,
                      uint16_t color, const char* s) {
  c.setFont(f);
  c.setTextColor(color);
  c.setCursor(x, y);
  c.print(s);
}

static int text_w(GFXcanvas1& c, const GFXfont* f, const char* s) {
  c.setFont(f);
  int16_t x1, y1;
  uint16_t w, h;
  c.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return (int)w;
}

static void draw_right(GFXcanvas1& c, const GFXfont* f, int xr, int y,
                       uint16_t color, const char* s) {
  draw_left(c, f, xr - text_w(c, f, s), y, color, s);
}

static void upper(char* dst, size_t n, const char* src) {
  size_t i = 0;
  for (; src[i] && i + 1 < n; i++) {
    char ch = src[i];
    dst[i] = (ch >= 'a' && ch <= 'z') ? (char)(ch - 32) : ch;
  }
  dst[i] = 0;
}

// Friendly destination label ("Penn" -> "New York").
static const char* dest_label(const char* destShort) {
  return strstr(destShort, "Penn") ? "New York" : destShort;
}

// --- formatting -------------------------------------------------------------

static void fmt_clock(time_t t, char* buf, size_t n, bool upperAmPm) {
  struct tm tm;
  localtime_r(&t, &tm);
  int h = tm.tm_hour % 12;
  if (h == 0) h = 12;
  if (upperAmPm)
    snprintf(buf, n, "%d:%02d %s", h, tm.tm_min, tm.tm_hour < 12 ? "AM" : "PM");
  else
    snprintf(buf, n, "%d:%02d%c", h, tm.tm_min, tm.tm_hour < 12 ? 'a' : 'p');
}

// --- station data -----------------------------------------------------------

static const long CATCH_GRACE = 120;  // seconds — still catchable if just past

struct DepRef {
  const BoardView* b;
  const DepView* d;
};

static bool belongs(const BoardView& b, const char* station) {
  return strstr(b.origin, station) || strstr(b.destShort, station);
}

// Collect this station's catchable departures across its destinations, sorted
// by departure time. Returns the count (<= cap).
static int collect_station(const BoardData& data, const char* station,
                           time_t now, DepRef* out, int cap) {
  int n = 0;
  for (int i = 0; i < data.nBoards; i++) {
    const BoardView& b = data.boards[i];
    if (!belongs(b, station)) continue;
    for (int j = 0; j < b.nDeps; j++) {
      if (b.deps[j].leaveEpoch < now - CATCH_GRACE) continue;
      if (n < cap) out[n++] = {&b, &b.deps[j]};
    }
  }
  for (int i = 1; i < n; i++) {  // insertion sort by depEpoch
    DepRef k = out[i];
    int j = i - 1;
    while (j >= 0 && out[j].d->depEpoch > k.d->depEpoch) {
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = k;
  }
  return n;
}

static int station_drive(const BoardData& data, const char* station) {
  for (int i = 0; i < data.nBoards; i++)
    if (belongs(data.boards[i], station)) return data.boards[i].driveMin;
  return 0;
}

// "leave in 22 min" / "leave in 1h03" / "leave now".
static void fmt_leavein(long mins, char* buf, size_t n) {
  if (mins <= 0)
    snprintf(buf, n, "leave now");
  else if (mins < 60)
    snprintf(buf, n, "leave in %ld min", mins);
  else
    snprintf(buf, n, "leave in %ldh%02ld", mins / 60, mins % 60);
}

// "catch the 12:23p, arrive 1:41p" (adds "to <dest>" when a station serves
// more than one destination).
static void fmt_detail(const DepRef& r, bool oneDest, char* buf, size_t n) {
  char dp[12], ar[12];
  fmt_clock(r.d->depEpoch, dp, sizeof(dp), false);
  fmt_clock(r.d->arrEpoch, ar, sizeof(ar), false);
  if (oneDest)
    snprintf(buf, n, "catch the %s, arrive %s", dp, ar);
  else
    snprintf(buf, n, "catch the %s to %s, arrive %s", dp,
             dest_label(r.b->destShort), ar);
}

// --- shared header ----------------------------------------------------------

static void draw_header(GFXcanvas1& c, const char* station, time_t now,
                        bool time_valid) {
  c.fillRect(0, 0, UI_W, HEADER_H, INK);
  char up[28];
  upper(up, sizeof(up), station);
  draw_left(c, &FreeSansBold12pt7b, PAD_L, 28, BG, up);
  if (time_valid) {
    char clk[16];
    fmt_clock(now, clk, sizeof(clk), true);
    draw_right(c, &FreeMonoBold12pt7b, UI_W - 10, 27, BG, clk);
  } else {
    draw_right(c, &FreeSans9pt7b, UI_W - 10, 27, BG, "syncing clock");
  }
}

// --- station screen ---------------------------------------------------------

static void draw_station_screen(GFXcanvas1& c, const BoardData& data,
                                time_t now, bool time_valid,
                                const char* station) {
  draw_header(c, station, now, time_valid);

  int drive = station_drive(data, station);
  char driveTxt[20] = "";
  if (drive > 0) snprintf(driveTxt, sizeof(driveTxt), "%d min drive", drive);

  if (!time_valid) {
    draw_left(c, &FreeSansBold12pt7b, PAD_L, 130, INK, "Setting the clock");
    draw_left(c, &FreeSans9pt7b, PAD_L, 156, INK, "Syncing time over WiFi...");
    return;
  }

  DepRef deps[6];
  int n = collect_station(data, station, now, deps, 6);

  if (n == 0) {
    if (driveTxt[0]) draw_right(c, &FreeSans9pt7b, UI_W - 10, 66, INK, driveTxt);
    draw_left(c, &FreeSansBold12pt7b, PAD_L, 128, INK, "No direct trains today");
    draw_left(c, &FreeSans9pt7b, PAD_L, 154, INK,
              "Nothing more from here on today's schedule.");
    return;
  }

  // Are all this station's trains headed to the same place?
  bool oneDest = true;
  for (int i = 1; i < n; i++)
    if (strcmp(deps[i].b->destShort, deps[0].b->destShort) != 0) oneDest = false;

  // Sub-line: to <dest(s)> ............... N min drive
  char sub[48];
  if (oneDest) {
    snprintf(sub, sizeof(sub), "to %s", dest_label(deps[0].b->destShort));
  } else {
    sub[0] = 0;
    for (int i = 0; i < n; i++) {
      const char* dl = dest_label(deps[i].b->destShort);
      if (sub[0] && strstr(sub, dl)) continue;  // skip a dest already listed
      size_t l = strlen(sub);
      snprintf(sub + l, sizeof(sub) - l, "%s%s", l ? " & " : "to ", dl);
    }
  }
  draw_left(c, &FreeSans9pt7b, PAD_L, 64, INK, sub);
  if (driveTxt[0]) draw_right(c, &FreeSans9pt7b, UI_W - 10, 64, INK, driveTxt);

  // Hero: the next catchable train — LEAVE IN <big number> + detail.
  char line[80];
  long leaveMin = (long)((deps[0].d->leaveEpoch - now) / 60);
  draw_left(c, &FreeSans9pt7b, PAD_L, 90, INK,
            leaveMin <= 0 ? "TIME TO GO" : "LEAVE IN");
  if (leaveMin <= 0) {
    draw_left(c, &FreeSansBold24pt7b, PAD_L, 132, INK, "now");
  } else if (leaveMin < 60) {
    char num[8];
    snprintf(num, sizeof(num), "%ld", leaveMin);
    draw_left(c, &FreeSansBold24pt7b, PAD_L, 132, INK, num);
    int nx = PAD_L + text_w(c, &FreeSansBold24pt7b, num) + 10;
    draw_left(c, &FreeSansBold12pt7b, nx, 132, INK, "min");
  } else {
    char big[10];
    snprintf(big, sizeof(big), "%ldh%02ld", leaveMin / 60, leaveMin % 60);
    draw_left(c, &FreeSansBold24pt7b, PAD_L, 132, INK, big);
  }
  fmt_detail(deps[0], oneDest, line, sizeof(line));
  draw_left(c, &FreeSans9pt7b, PAD_L, 158, INK, line);

  // Up next — same "leave in / catch / arrive" phrasing, quieter.
  if (n > 1) {
    c.drawFastHLine(PAD_L, 174, UI_W - 2 * PAD_L, INK);
    char lbl[12];
    upper(lbl, sizeof(lbl), "up next");
    draw_left(c, &FreeSans9pt7b, PAD_L, 192, INK, lbl);
    int y = 192;
    for (int i = 1; i < n && i <= 2; i++) {
      char lin[24];
      fmt_leavein((long)((deps[i].d->leaveEpoch - now) / 60), lin, sizeof(lin));
      y += 24;
      draw_left(c, &FreeSansBold9pt7b, PAD_L, y, INK, lin);
      y += 18;
      fmt_detail(deps[i], oneDest, line, sizeof(line));
      draw_left(c, &FreeSans9pt7b, PAD_L, y, INK, line);
    }
  }
}

// --- entry ------------------------------------------------------------------

void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, UiScreen screen) {
  canvas.fillScreen(BG);

  if (data.nBoards == 0) {
    draw_header(canvas, "Family dashboard", now, time_valid);
    const char* msg = data.fetchedAt == 0 ? "Reaching the dashboard..."
                                          : "Can't reach the dashboard";
    draw_left(canvas, &FreeSans9pt7b, PAD_L, UI_H / 2, INK, msg);
    return;
  }

  int idx = (screen == SCREEN_BERNARDSVILLE) ? 1 : 0;
  draw_station_screen(canvas, data, now, time_valid, STATION_NAME[idx]);
}
