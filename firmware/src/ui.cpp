// firmware/src/ui.cpp — renders the live family-dash board (board_data.h).
//
// One combined screen for someone about to leave the house for a train. Every
// train to the city from both home stations is merged into a single list in the
// order you'd have to LEAVE for it. The next one you can still catch is the
// hero — a big countdown and the clock time to leave by — and the ones after it
// sit below, one line each. The bottom band says how far to trust the screen.
// 400x300, 1-bit.
//
// Rules this file exists to keep:
//   1. The big number's meaning comes from the server (`showLeave`), never from
//      whether a leave time happens to be present. "LEAVE IN" = leave the
//      house; anything else is labelled as the train departing.
//   2. "No trains" is only ever said when the server, freshly asked, had none.
//      A missing clock, missing WiFi, an unreachable server, an expired
//      timetable and an old board each say what they are.
//   3. Everything ticks on the minute (leave times are floored to the minute),
//      and a far-off train is shown as a clock time, not a countdown — so the
//      picture changes at most once a minute, and not at all overnight.
#include "ui.h"

#include <Fonts/FreeSansBold24pt7b.h>
#include <Fonts/FreeSansBold12pt7b.h>
#include <Fonts/FreeSansBold9pt7b.h>
#include <Fonts/FreeSans9pt7b.h>
#include <Fonts/FreeMonoBold12pt7b.h>
#include <cstdio>
#include <cstring>

#include "fonts/FreeSansBold48pt7b.h"

static const uint16_t INK = 1;
static const uint16_t BG = 0;

static const int HEADER_H = 36;
static const int PAD_L = 14;
static const int RIGHT = UI_W - 10;  // right text edge

// Vertical rhythm (text baselines).
static const int Y_HEAD = 25;     // TO THE CITY                 7:05 AM
static const int Y_LABEL = 53;    // LEAVE IN                16 min drive
static const int Y_HERO = 127;    // 12 min   (48pt digits: 67 px above this)
static const int Y_SIDE_A = 90;   //                             by 7:17a
static const int Y_SIDE_B = 118;  //                             [+6 late]
static const int Y_DETAIL = 152;  // Morristown 7:38a -> Penn 8:54a
static const int Y_CAP = 172;     // LEAVE BY ----------------------
static const int Y_ROW = 196;     // first later train
static const int ROW_PITCH = 24;  // four airy rows rather than five tight ones
static const int FOOTER_TOP = 278;  // bottom status band
static const int FOOTER_BASE = 294;

// Row columns, sized for the widest row there can be:
//   12:57p  Bernardsville  12:12 -> Hoboken 12:29p
static const int X_STATION = 75;  // after "12:57p" in bold
static const int X_TRAIN = 184;   // after "Bernardsville"
static const int X_ARROW = 233;   // after "12:12"; the same on every row

// A countdown is only shown this close to leaving; further out (and for any
// later day, and all night) the screen gives the clock time instead.
static const long COUNTDOWN_MAX_MIN = 90;

// Delays shorter than this aren't worth a badge.
static const int DELAY_FLAG_MIN = 3;

// Live status (delay / boarding) is only true for a few minutes; once the
// board is older than this it's dropped rather than shown as current.
static const long LIVE_FRESH_SEC = 10 * 60;

// --- text helpers -----------------------------------------------------------

static void draw_left(GFXcanvas1& c, const GFXfont* f, int x, int y,
                      uint16_t color, const char* s) {
  c.setFont(f);
  c.setTextColor(color);
  c.setCursor(x, y);
  c.print(s);
}

static int text_w(GFXcanvas1& c, const GFXfont* f, const char* s) {
  if (!s[0]) return 0;
  c.setFont(f);
  int16_t x1, y1;
  uint16_t w, h;
  c.getTextBounds(s, 0, 0, &x1, &y1, &w, &h);
  return (int)w + x1;  // advance to the right edge of the ink
}

static void draw_right(GFXcanvas1& c, const GFXfont* f, int xr, int y,
                       uint16_t color, const char* s) {
  draw_left(c, f, xr - text_w(c, f, s), y, color, s);
}

// A small right-pointing arrow (the 7-bit fonts have no such glyph), sitting
// at x-height on the text line whose baseline is `y`. 12 px wide.
static const int ARROW_W = 12;
static void draw_arrow(GFXcanvas1& c, int x, int y, uint16_t color) {
  const int my = y - 5;
  c.drawFastHLine(x, my, ARROW_W - 3, color);
  c.fillTriangle(x + ARROW_W - 1, my, x + ARROW_W - 6, my - 4,
                 x + ARROW_W - 6, my + 4, color);
}

// Friendly place label ("Penn" / "New York Penn Station" -> short form).
static const char* station_label(const char* place) {
  return strstr(place, "Penn") ? "New York" : place;
}

// --- time -------------------------------------------------------------------

static time_t floor_min(time_t t) { return t - (t % 60); }

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

// "7:45" — no am/pm, for a time that sits right next to one that has it.
static void fmt_clock_bare(time_t t, char* buf, size_t n) {
  struct tm tm;
  localtime_r(&t, &tm);
  int h = tm.tm_hour % 12;
  if (h == 0) h = 12;
  snprintf(buf, n, "%d:%02d", h, tm.tm_min);
}

// A number that identifies the local calendar day of `t`.
static long day_index(time_t t) {
  struct tm tm;
  localtime_r(&t, &tm);
  return (long)tm.tm_year * 400 + tm.tm_yday;
}

bool ui_is_night(time_t now) {
  struct tm tm;
  localtime_r(&now, &tm);
  return tm.tm_hour >= 23 || tm.tm_hour < 5;
}

static long stale_sec(time_t now) {
  return ui_is_night(now) ? UI_STALE_SEC_NIGHT : UI_STALE_SEC;
}
static long offline_sec(time_t now) {
  return ui_is_night(now) ? UI_OFFLINE_SEC_NIGHT : UI_OFFLINE_SEC;
}

// --- the merged train list --------------------------------------------------

static const long CATCH_GRACE = 120;  // seconds — still catchable if just past

// Does this train's countdown track leaving the house? Only when the server
// says this is a leave-the-house board AND it sent a leave time for the train.
static bool counts_leave(const BoardData& data, const DepView& d) {
  return data.showLeave && d.leaveEpoch != 0;
}

// The instant the countdown tracks, floored to the minute (so "leave by 7:17"
// and "leave in 12 min" always agree, and tick together on the minute).
static time_t go_epoch(const BoardData& data, const DepView& d) {
  return floor_min(counts_leave(data, d) ? d.leaveEpoch : d.depEpoch);
}

struct DepRef {
  const BoardView* b;
  const DepView* d;
};

static const int MAX_TRAINS = MAX_BOARDS * MAX_DEPS;

// Every still-catchable train from every board, in the order you'd have to
// leave for them. Returns the count.
static int collect(const BoardData& data, time_t now, DepRef* out) {
  int n = 0;
  for (int i = 0; i < data.nBoards && i < MAX_BOARDS; i++) {
    const BoardView& b = data.boards[i];
    for (int j = 0; j < b.nDeps && j < MAX_DEPS; j++) {
      if (go_epoch(data, b.deps[j]) < now - CATCH_GRACE) continue;
      out[n++] = {&b, &b.deps[j]};
    }
  }
  for (int i = 1; i < n; i++) {  // insertion sort: leave time, then departure
    DepRef k = out[i];
    const time_t kg = go_epoch(data, *k.d);
    int j = i - 1;
    while (j >= 0) {
      const time_t jg = go_epoch(data, *out[j].d);
      if (jg < kg || (jg == kg && out[j].d->depEpoch <= k.d->depEpoch)) break;
      out[j + 1] = out[j];
      j--;
    }
    out[j + 1] = k;
  }
  return n;
}

// The hero: the first train that is actually running. -1 if all are cancelled.
static int pick_hero(const DepRef* deps, int n) {
  for (int i = 0; i < n; i++)
    if (deps[i].d->live != LIVE_CANCELLED) return i;
  return -1;
}

// Live state as it should be shown: a cancellation stays a cancellation, but
// delays / boarding go stale within minutes and are dropped on an old board —
// and a delay too small to matter isn't flagged at all.
static uint8_t shown_live(const DepView& d, bool liveFresh) {
  if (d.live == LIVE_CANCELLED) return LIVE_CANCELLED;
  if (!liveFresh) return LIVE_NONE;
  if (d.live == LIVE_DELAYED && d.delayMin > 0 && d.delayMin < DELAY_FLAG_MIN)
    return LIVE_ON_TIME;
  return d.live;
}

// Exception text for a train that needs attention; empty when running
// normally. `compact` is the short form used in the rows.
static void fmt_exception(uint8_t live, int delayMin, bool compact, char* buf,
                          size_t n) {
  if (live == LIVE_CANCELLED)
    snprintf(buf, n, "CANCELLED");
  else if (live == LIVE_BOARDING)
    snprintf(buf, n, compact ? "BOARDING" : "ALL ABOARD");
  else if (live == LIVE_DELAYED && delayMin > 0)
    snprintf(buf, n, compact ? "+%d" : "+%d late", delayMin);
  else if (live == LIVE_DELAYED)  // delayed by an unknown amount
    snprintf(buf, n, compact ? "LATE" : "DELAYED");
  else
    buf[0] = 0;
}

// --- pills ------------------------------------------------------------------

static int pill_w(GFXcanvas1& c, const char* s) {
  return text_w(c, &FreeSansBold9pt7b, s) + 12;
}

// Inverted pill (filled, white text), right-aligned so its right edge is at xr,
// with the text baseline at y. The loud treatment is reserved for exceptions.
static void draw_pill(GFXcanvas1& c, int xr, int y, const char* s) {
  const GFXfont* f = &FreeSansBold9pt7b;
  int w = text_w(c, f, s);
  c.fillRoundRect(xr - w - 12, y - 14, w + 12, 19, 4, INK);
  draw_left(c, f, xr - w - 6, y, BG, s);
}

// Outlined tag, right-aligned at xr — a notice that isn't a train exception.
static void draw_tag(GFXcanvas1& c, int xr, int y, const char* s) {
  const GFXfont* f = &FreeSansBold9pt7b;
  int w = text_w(c, f, s);
  c.drawRoundRect(xr - w - 12, y - 14, w + 12, 19, 4, INK);
  draw_left(c, f, xr - w - 6, y, INK, s);
}

// --- shared pieces ----------------------------------------------------------

// The inverted header bar: a title, and on the right the clock with a small
// "live" mark before it. At night the clock is left out (see ui_is_night).
static void draw_header(GFXcanvas1& c, const char* title, time_t now,
                        bool time_valid, bool live) {
  c.fillRect(0, 0, UI_W, HEADER_H, INK);
  draw_left(c, &FreeSansBold12pt7b, PAD_L, Y_HEAD, BG, title);
  if (!time_valid) {
    draw_right(c, &FreeSans9pt7b, RIGHT, Y_HEAD - 1, BG, "syncing clock");
    return;
  }
  if (ui_is_night(now)) return;
  char clk[16];
  fmt_clock(now, clk, sizeof(clk), true);
  draw_right(c, &FreeMonoBold12pt7b, RIGHT, Y_HEAD - 1, BG, clk);
  if (live) {
    int x = RIGHT - text_w(c, &FreeMonoBold12pt7b, clk) - 14;
    c.fillCircle(x, HEADER_H / 2, 4, BG);
  }
}

// A titled message in the body: one bold line and up to two plain lines.
static void draw_message(GFXcanvas1& c, const char* title, const char* l1,
                         const char* l2) {
  draw_left(c, &FreeSansBold12pt7b, PAD_L, 128, INK, title);
  if (l1 && l1[0]) draw_left(c, &FreeSans9pt7b, PAD_L, 156, INK, l1);
  if (l2 && l2[0]) draw_left(c, &FreeSans9pt7b, PAD_L, 178, INK, l2);
}

// Quiet one-line note in the bottom band.
static void draw_footer(GFXcanvas1& c, const char* s) {
  draw_left(c, &FreeSans9pt7b, PAD_L, FOOTER_BASE, INK, s);
}

// Loud inverted bar across the bottom band: a bold lead on the left and, when
// there's room for it, a plain caveat on the right.
static void draw_banner(GFXcanvas1& c, const char* lead) {
  static const char* const CAVEAT[] = {"times may be out of date",
                                       "may be out of date", "old data"};
  c.fillRect(0, FOOTER_TOP, UI_W, UI_H - FOOTER_TOP, INK);
  draw_left(c, &FreeSansBold9pt7b, PAD_L, FOOTER_BASE, BG, lead);
  int leadEnd = PAD_L + text_w(c, &FreeSansBold9pt7b, lead);
  for (const char* cv : CAVEAT) {
    if (leadEnd + 14 + text_w(c, &FreeSans9pt7b, cv) <= RIGHT) {
      draw_right(c, &FreeSans9pt7b, RIGHT, FOOTER_BASE, BG, cv);
      break;
    }
  }
}

// An NJ Transit service alert in the bottom band: a small "!" box, then the
// text. One line is all there is room for, so a longer alert is wrapped into
// lines and the band shows one of them, moving to the next each minute — the
// whole message can be read without the picture changing any more often than
// the clock already makes it. (At night, when the screen holds still, it stays
// on the first line.)
static void draw_alert(GFXcanvas1& c, const char* text, time_t now) {
  const GFXfont* f = &FreeSans9pt7b;
  c.fillRoundRect(PAD_L, FOOTER_BASE - 14, 16, 19, 4, INK);
  draw_left(c, &FreeSansBold9pt7b, PAD_L + 5, FOOTER_BASE, BG, "!");
  const int x = PAD_L + 22;

  char clean[200];
  snprintf(clean, sizeof(clean), "%s", text);
  for (char* p = clean; *p; p++)  // the fonts are 7-bit; anything else -> space
    if ((unsigned char)*p < 32 || (unsigned char)*p > 126) *p = ' ';
  if (text_w(c, f, clean) <= RIGHT - x) {
    draw_left(c, f, x, FOOTER_BASE, INK, clean);
    return;
  }

  // Too long for the line: cut it at a word and end with "...". (The sign only
  // gets alerts that affect trains; the full text is on the web page.)
  {
    const int avail = RIGHT - x - text_w(c, f, "...");
    int cut = (int)strlen(clean);
    char part[200];
    while (cut > 0) {
      while (cut > 0 && clean[cut - 1] != ' ') cut--;  // back to a word start
      while (cut > 0 && clean[cut - 1] == ' ') cut--;  // and off the space
      snprintf(part, sizeof(part), "%.*s", cut, clean);
      if (text_w(c, f, part) <= avail) break;
    }
    if (cut <= 0) snprintf(part, sizeof(part), "%.20s", clean);
    char line[204];
    snprintf(line, sizeof(line), "%s...", part);
    draw_left(c, f, x, FOOTER_BASE, INK, line);
    (void)now;
    return;
  }

  // (Unused: stepping a long alert one line a minute.)
  const int room = RIGHT - x - 34;
  static const int MAX_LINES = 8;
  int start[MAX_LINES], count[MAX_LINES], n = 0;
  const int len = (int)strlen(clean);
  char tmp[200];
  int p = 0;
  while (p < len && clean[p] == ' ') p++;
  while (p < len && n < MAX_LINES) {
    int good = p, e = p;
    while (e < len) {
      while (e < len && clean[e] == ' ') e++;
      while (e < len && clean[e] != ' ') e++;
      snprintf(tmp, sizeof(tmp), "%.*s", e - p, clean + p);
      if (text_w(c, f, tmp) > room) break;
      good = e;
    }
    if (good == p) {  // one word wider than the line: cut it
      good = p;
      while (good < len) {
        snprintf(tmp, sizeof(tmp), "%.*s", good + 1 - p, clean + p);
        if (text_w(c, f, tmp) > room) break;
        good++;
      }
      if (good == p) good = p + 1;
    }
    start[n] = p;
    count[n] = good - p;
    n++;
    p = good;
    while (p < len && clean[p] == ' ') p++;
  }
  if (n == 0) return;

  const int i = ui_is_night(now) ? 0 : (int)((now / 60) % n);
  snprintf(tmp, sizeof(tmp), "%.*s", count[i], clean + start[i]);
  draw_left(c, f, x, FOOTER_BASE, INK, tmp);
  char ctr[12];
  snprintf(ctr, sizeof(ctr), "%d/%d", i + 1, n);
  draw_right(c, &FreeSansBold9pt7b, RIGHT, FOOTER_BASE, INK, ctr);
}

// "9:41a", or "Tue 9:41a" when that wasn't today.
static void fmt_since(time_t t, time_t now, char* buf, size_t n) {
  char clk[12];
  fmt_clock(t, clk, sizeof(clk), false);
  if (day_index(t) == day_index(now)) {
    snprintf(buf, n, "%s", clk);
  } else {
    static const char* const WD[7] = {"Sun", "Mon", "Tue", "Wed",
                                      "Thu", "Fri", "Sat"};
    struct tm tm;
    localtime_r(&t, &tm);
    snprintf(buf, n, "%s %s", WD[tm.tm_wday % 7], clk);
  }
}

static long board_age(const BoardData& data, time_t now) {
  long age = (long)(now - data.fetchedAt);
  return age < 0 ? 0 : age;
}

// --- the hero ---------------------------------------------------------------

// "Morristown 7:38a -> Penn 8:54a". WHICH station to drive to is the one thing
// on this line that must not be misread, so its name is set larger than the
// times — unless the line would then run off the screen.
static void draw_route(GFXcanvas1& c, int x, int y, const DepRef& r) {
  const GFXfont* f = &FreeSansBold9pt7b;
  const char* station = station_label(r.b->origin);
  char dp[12], tail[40];
  fmt_clock(r.d->depEpoch, dp, sizeof(dp), false);
  {
    char ar[12];
    fmt_clock(r.d->arrEpoch, ar, sizeof(ar), false);
    snprintf(tail, sizeof(tail), "%s %s", r.b->destShort, ar);
  }
  const int rest = 7 + text_w(c, f, dp) + 5 + ARROW_W + 5 + text_w(c, f, tail);
  const GFXfont* sf = &FreeSansBold12pt7b;
  if (x + text_w(c, sf, station) + rest > RIGHT) sf = f;

  draw_left(c, sf, x, y, INK, station);
  x += text_w(c, sf, station) + 7;
  draw_left(c, f, x, y, INK, dp);
  x += text_w(c, f, dp) + 5;
  draw_arrow(c, x, y, INK);
  x += ARROW_W + 5;
  draw_left(c, f, x, y, INK, tail);
}

// The top half: label, the big number, the time to leave by, and the train.
static void draw_hero(GFXcanvas1& c, const BoardData& data, time_t now,
                      const DepRef* deps, int n, int hero, bool liveFresh) {
  const GFXfont* big = &FreeSansBold48pt7b;

  if (hero < 0) {
    // Every train we hold is cancelled.
    const DepRef& r = deps[0];
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_LABEL, INK, "NEXT TRAIN");
    draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO - 12, INK, "cancelled");
    char line[64], dp[12];
    fmt_clock(r.d->depEpoch, dp, sizeof(dp), false);
    snprintf(line, sizeof(line), "the %s from %s is not running", dp,
             station_label(r.b->origin));
    draw_left(c, &FreeSansBold9pt7b, PAD_L, Y_DETAIL, INK, line);
    return;
  }

  const DepRef& r = deps[hero];
  const DepView& h = *r.d;
  const bool leave = counts_leave(data, h);
  const time_t go = go_epoch(data, h);
  const time_t nowMin = floor_min(now);
  const long mins = (long)((go - nowMin) / 60);
  const bool otherDay = day_index(go) != day_index(now) && go > now;
  // A countdown ticks every minute, so it is kept for when it is useful: the
  // last hour and a half before leaving, and never at night, when the screen
  // is meant to hold still.
  const bool asClock =
      otherDay || mins > COUNTDOWN_MAX_MIN || ui_is_night(now);
  const bool due = mins <= 0 && !asClock;

  // --- label row: what the number means; the drive on the right -------------
  if (otherDay) {
    // TOMORROW (dot) LEAVE AT — the day is the loudest word on the row.
    const char* what = leave ? "LEAVE AT" : "TRAIN DEPARTS AT";
    draw_left(c, &FreeSansBold9pt7b, PAD_L, Y_LABEL, INK, "TOMORROW");
    int x = PAD_L + text_w(c, &FreeSansBold9pt7b, "TOMORROW") + 9;
    c.fillCircle(x, Y_LABEL - 5, 2, INK);
    draw_left(c, &FreeSans9pt7b, x + 9, Y_LABEL, INK, what);
  } else {
    const char* label;
    if (leave) label = due ? "TIME TO GO" : (asClock ? "LEAVE AT" : "LEAVE IN");
    else if (data.showLeave)
      label = due ? "TRAIN DEPARTING"
                  : (asClock ? "TRAIN DEPARTS AT" : "TRAIN DEPARTS IN");
    else label = due ? "DEPARTING" : (asClock ? "DEPARTS AT" : "DEPARTS IN");
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_LABEL, INK, label);
  }
  if (data.showLeave) {
    if (leave && r.b->driveMin > 0) {
      char txt[24];
      snprintf(txt, sizeof(txt), "%s%d min drive",
               r.b->driveSource == DRIVE_EARLIER ? "~" : "", r.b->driveMin);
      draw_right(c, &FreeSans9pt7b, RIGHT, Y_LABEL, INK, txt);
    } else if (!leave) {
      // Called out, because it changes what the big number means.
      draw_tag(c, RIGHT, Y_LABEL, "no drive time");
    }
  }

  // --- the big number ---------------------------------------------------------
  char badge[16];
  fmt_exception(shown_live(h, liveFresh), h.delayMin, false, badge,
                sizeof(badge));

  if (asClock) {
    char clk[12];
    struct tm tm;
    localtime_r(&go, &tm);
    int hr = tm.tm_hour % 12;
    if (hr == 0) hr = 12;
    snprintf(clk, sizeof(clk), "%d:%02d", hr, tm.tm_min);
    draw_left(c, big, PAD_L - 2, Y_HERO, INK, clk);
    int nx = PAD_L - 2 + text_w(c, big, clk) + 8;
    draw_left(c, &FreeSansBold12pt7b, nx, Y_HERO, INK,
              tm.tm_hour < 12 ? "am" : "pm");
    if (badge[0]) draw_pill(c, RIGHT, Y_SIDE_A, badge);
  } else {
    if (due) {
      draw_left(c, big, PAD_L - 2, Y_HERO, INK, "now");
    } else {
      char num[8];
      snprintf(num, sizeof(num), "%ld", mins);
      draw_left(c, big, PAD_L - 2, Y_HERO, INK, num);
      int nx = PAD_L - 2 + text_w(c, big, num) + 10;
      draw_left(c, &FreeSansBold12pt7b, nx, Y_HERO, INK, "min");
    }
    if (leave) {
      // The clock time to be out of the door by.
      char by[20], clk[12];
      fmt_clock(go, clk, sizeof(clk), false);
      snprintf(by, sizeof(by), "by %s", clk);
      draw_right(c, &FreeSansBold12pt7b, RIGHT, Y_SIDE_A, INK, by);
      if (badge[0]) draw_pill(c, RIGHT, Y_SIDE_B, badge);
    } else if (badge[0]) {
      draw_pill(c, RIGHT, Y_SIDE_A, badge);
    }
  }

  // --- which train that is ------------------------------------------------------
  draw_route(c, PAD_L, Y_DETAIL, r);
}

// --- the rows ---------------------------------------------------------------

// One later train on one line:
//   7:20a  Bernardsville  7:45 -> Hoboken 8:28a
// The first column is the clock time to leave by (or, with no drive time, the
// departure). The train's own time follows without am/pm — it is minutes after
// the time beside it. An exception replaces the arrival time with a compact
// pill; a cancelled train is struck through.
static void draw_row(GFXcanvas1& c, const BoardData& data, const DepRef& r,
                     int y, bool liveFresh) {
  const GFXfont* f = &FreeSans9pt7b;
  const DepView& d = *r.d;
  const uint8_t live = shown_live(d, liveFresh);
  const bool leave = counts_leave(data, d);

  char lead[12], dp[12], ar[12], badge[16];
  fmt_clock(go_epoch(data, d), lead, sizeof(lead), false);
  fmt_clock_bare(d.depEpoch, dp, sizeof(dp));
  fmt_clock(d.arrEpoch, ar, sizeof(ar), false);
  fmt_exception(live, d.delayMin, true, badge, sizeof(badge));

  const char* station = station_label(r.b->origin);
  draw_left(c, &FreeSansBold9pt7b, PAD_L, y, INK, lead);
  draw_left(c, f, X_STATION, y, INK, station);

  if (live == LIVE_CANCELLED) {
    // No destination or arrival for a train that isn't running: the struck
    // times and the pill say all there is to say.
    draw_left(c, f, X_TRAIN, y, INK, dp);
    const int end = X_TRAIN + text_w(c, f, dp);
    c.drawFastHLine(PAD_L - 2, y - 5, end + 2 - (PAD_L - 2), INK);
    c.drawFastHLine(PAD_L - 2, y - 4, end + 2 - (PAD_L - 2), INK);
    draw_pill(c, RIGHT, y, badge);
    return;
  }

  // With a leave time in the first column, the train's own time goes here;
  // without one the first column already is the train's time.
  if (leave) draw_left(c, f, X_TRAIN, y, INK, dp);

  // Then just where it goes — "-> Penn". The arrival time is only given for
  // the train shown big; on these rows it was more ink than it was worth.
  (void)ar;
  draw_arrow(c, X_ARROW, y, INK);
  draw_left(c, f, X_ARROW + ARROW_W + 8, y, INK, r.b->destShort);
  if (badge[0]) draw_pill(c, RIGHT, y, badge);
}

static int page_count_for(int n, int hero) {
  const int rows = n - (hero >= 0 ? 1 : (n > 0 ? 1 : 0));
  return rows <= UI_ROWS ? 1 : (rows + UI_ROWS - 1) / UI_ROWS;
}

static void draw_rows(GFXcanvas1& c, const BoardData& data, const DepRef* deps,
                      int n, int hero, int page, bool liveFresh) {
  // Everything except the train shown big, in order. (Cancelled trains ahead of
  // the hero stay in the list, so it's clear why they aren't the big one.)
  static DepRef rows[MAX_TRAINS];
  int nr = 0;
  const int skip = hero >= 0 ? hero : 0;
  for (int i = 0; i < n; i++)
    if (i != skip) rows[nr++] = deps[i];
  if (nr == 0) return;

  const int pages = page_count_for(n, hero);
  if (page >= pages) page = pages - 1;
  if (page < 0) page = 0;

  // Caption over the first column, a rule, and the page mark when paged.
  bool anyLeave = false;
  for (int i = 0; i < nr; i++)
    if (counts_leave(data, *rows[i].d)) anyLeave = true;
  const char* cap = anyLeave ? "LEAVE BY" : "DEPARTS";
  draw_left(c, &FreeSans9pt7b, PAD_L, Y_CAP, INK, cap);
  int lx = PAD_L + text_w(c, &FreeSans9pt7b, cap) + 8;
  int rx = RIGHT;
  if (page > 0) {
    char pg[24];
    snprintf(pg, sizeof(pg), "later %d/%d", page + 1, pages);
    draw_pill(c, RIGHT, Y_CAP, pg);
    rx = RIGHT - pill_w(c, pg) - 8;
  }
  c.drawFastHLine(lx, Y_CAP - 5, rx - lx, INK);

  int y = Y_ROW;
  for (int i = page * UI_ROWS; i < nr && i < (page + 1) * UI_ROWS; i++) {
    draw_row(c, data, rows[i], y, liveFresh);
    y += ROW_PITCH;
  }
}

// The server, freshly asked, has no trains. Say so in the words of the board it
// sent — never "today" on tomorrow's board.
static void draw_no_trains(GFXcanvas1& c, const BoardData& data) {
  switch (data.mode) {
    case MODE_EVENING:
      draw_message(c, "No more direct trains tonight",
                   "Nothing further on tonight's schedule.", "");
      break;
    case MODE_NEXT_MORNING:
      draw_message(c, "No direct trains tomorrow morning",
                   "Nothing to the city on tomorrow's schedule.", "");
      break;
    default:
      draw_message(c, "No more direct trains today",
                   "Nothing further to the city on today's schedule.", "");
  }
}

static const char* title_for(const BoardData& data) {
  switch (data.mode) {
    case MODE_EVENING: return "HEADING HOME";
    case MODE_NEXT_MORNING: return "TOMORROW";  // (longer would hit the clock)
    default: return "TO THE CITY";
  }
}

// --- entry ------------------------------------------------------------------

bool ui_degraded(const BoardData& data, time_t now, bool time_valid) {
  if (data.fetchedAt == 0 || data.nBoards == 0 || data.scheduleExpired)
    return true;
  return time_valid && board_age(data, now) > stale_sec(now);
}

int ui_train_count(const BoardData& data, time_t now) {
  static DepRef deps[MAX_TRAINS];
  return collect(data, now, deps);
}

int ui_page_count(const BoardData& data, time_t now) {
  static DepRef deps[MAX_TRAINS];
  const int n = collect(data, now, deps);
  return page_count_for(n, pick_hero(deps, n));
}

void ui_draw_notice(GFXcanvas1& canvas, const char* title, const char* line1,
                    const char* line2) {
  canvas.fillScreen(BG);
  canvas.setTextWrap(false);
  canvas.fillRect(0, 0, UI_W, HEADER_H, INK);
  draw_left(canvas, &FreeSansBold12pt7b, PAD_L, Y_HEAD, BG, "FAMILY DASHBOARD");
  draw_message(canvas, title, line1, line2);
}

void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, int page) {
  canvas.fillScreen(BG);
  canvas.setTextWrap(false);  // clip, never spill onto the next line
  const bool wifiUp = net == NET_CONNECTED;

  // 1. No clock: every countdown would be wrong, so show none.
  if (!time_valid) {
    draw_header(canvas, "FAMILY DASHBOARD", now, false, false);
    draw_message(canvas, "Setting the clock",
                 wifiUp ? "Syncing the time over WiFi..."
                        : "Waiting for WiFi to set the time...",
                 "");
    return;
  }

  // 2. Never had a board: say which link in the chain is missing.
  if (data.fetchedAt == 0) {
    draw_header(canvas, "FAMILY DASHBOARD", now, true, false);
    if (!wifiUp) {
      draw_message(canvas, "No WiFi", "Can't join the WiFi network.",
                   "Retrying every 10 seconds.");
    } else if (data.failStreak == 0) {
      draw_message(canvas, "Reaching the dashboard...",
                   "WiFi is connected. Fetching trains.", "");
    } else {
      char why[64];
      if (data.lastHttpCode > 0)
        snprintf(why, sizeof(why), "The server answered with an error (HTTP %d).",
                 data.lastHttpCode);
      else
        snprintf(why, sizeof(why), "WiFi is up but the server isn't answering.");
      draw_message(canvas, "Can't reach the dashboard", why,
                   "Retrying every 30 seconds.");
    }
    return;
  }

  const bool night = ui_is_night(now);
  const long age = board_age(data, now);
  const bool offline = age > offline_sec(now);
  const bool stale = age > stale_sec(now);
  // By day the board is refetched every 3 min, so anything older than a few
  // minutes means trouble; at night it is fetched less often on purpose.
  const bool liveFresh = age <= (night ? UI_STALE_SEC_NIGHT : LIVE_FRESH_SEC);
  char since[20];
  fmt_since(data.fetchedAt, now, since, sizeof(since));

  static DepRef deps[MAX_TRAINS];
  const int n = collect(data, now, deps);
  const int hero = pick_hero(deps, n);

  draw_header(canvas, title_for(data), now, true,
              data.liveFeed == FEED_OK && !stale);

  // 3. Long out of touch: an old board with nothing left on it (or one from
  //    half a day ago) is not "no trains" — it's "we don't know".
  if (offline && (n == 0 || age > UI_OFFLINE_HIDE_SEC)) {
    char title[40];
    snprintf(title, sizeof(title), "Offline since %s", since);
    draw_message(canvas, title,
                 wifiUp ? "Can't reach the dashboard server,"
                        : "WiFi is down,",
                 "so trains can't be shown. Still retrying.");
    return;
  }

  // 4. The server's timetable has run out and it has nothing live either.
  if (n == 0 && data.scheduleExpired) {
    draw_message(canvas, "Schedule out of date",
                 "The server's train timetable has expired,",
                 "so trains can't be shown until it's refreshed.");
  } else if (n == 0) {
    draw_no_trains(canvas, data);
  } else {
    draw_hero(canvas, data, now, deps, n, hero, liveFresh);
    draw_rows(canvas, data, deps, n, hero, page, liveFresh);
  }

  // 5. Bottom band: how much to trust what's above, then anything NJ Transit
  //    wants riders to know.
  char foot[64];
  if (offline) {
    snprintf(foot, sizeof(foot), "OFFLINE since %s", since);
    draw_banner(canvas, foot);
  } else if (stale) {
    snprintf(foot, sizeof(foot), "%supdated %ld min ago, retrying",
             wifiUp ? "" : "WiFi down - ", age / 60);
    draw_footer(canvas, foot);
  } else if (data.alert[0]) {
    draw_alert(canvas, data.alert, now);
  } else if (data.liveFeed == FEED_DOWN && data.mode != MODE_NEXT_MORNING &&
             n > 0) {
    draw_footer(canvas, "schedule only - no live status");
  } else if (data.scheduleExpired && n > 0) {
    draw_footer(canvas, "timetable out of date - live trains only");
  }
}
