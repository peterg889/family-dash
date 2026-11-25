// firmware/src/ui.cpp — renders the live family-dash board (board_data.h).
//
// One screen per home station (Morristown / Bernardsville). The station name is
// the screen's identity; the countdown for its next catchable train is the one
// hero; a short "up next" list sits quietly below; the bottom band is reserved
// for saying how fresh the data is. Words in a sans face, the clock in a
// monospace face. 400x300, 1-bit.
//
// Two rules this file exists to keep:
//   1. The big number's meaning comes from the server (`showLeave`), never from
//      whether a leave time happens to be present. "LEAVE IN" = leave the
//      house; anything else is labelled as the train departing.
//   2. "No trains" is only ever said when the server, freshly asked, had none.
//      A missing clock, missing WiFi, an unreachable server, an expired
//      timetable and an old board each say what they are.
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
static const int RIGHT = UI_W - 10;  // right text edge

// Vertical rhythm (text baselines).
static const int Y_SUB = 64;      // "to New York"            16 min drive
static const int Y_LABEL = 90;    // LEAVE IN
static const int Y_HERO = 132;    // 12 min
static const int Y_DETAIL = 158;  // catch the 10:37a, arrive 11:53a
static const int Y_NEXT = 178;    // -- UP NEXT ------------------
static const int Y_ITEM = 204;    // first up-next entry (two lines, 18 apart)
static const int ITEM_PITCH = 42;
static const int FOOTER_TOP = 278;   // bottom status band
static const int FOOTER_BASE = 294;

// Live status (delay / boarding / track) is only true for a few minutes; once
// the board is older than this it's dropped rather than shown as current.
static const long LIVE_FRESH_SEC = 10 * 60;

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

static void upper(char* dst, size_t n, const char* src) {
  size_t i = 0;
  for (; src[i] && i + 1 < n; i++) {
    char ch = src[i];
    dst[i] = (ch >= 'a' && ch <= 'z') ? (char)(ch - 32) : ch;
  }
  dst[i] = 0;
}

// Friendly place label ("Penn" / "New York Penn Station" -> "New York").
static const char* dest_label(const char* place) {
  return strstr(place, "Penn") ? "New York" : place;
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

// A number that identifies the local calendar day of `t`.
static long day_index(time_t t) {
  struct tm tm;
  localtime_r(&t, &tm);
  return (long)tm.tm_year * 400 + tm.tm_yday;
}

// --- station data -----------------------------------------------------------

static const long CATCH_GRACE = 120;  // seconds — still catchable if just past

// Does this train's countdown track leaving the house? Only when the server
// says this is a leave-the-house board AND it sent a leave time for the train.
static bool counts_leave(const BoardData& data, const DepView& d) {
  return data.showLeave && d.leaveEpoch != 0;
}

// The instant the countdown tracks.
static time_t go_epoch(const BoardData& data, const DepView& d) {
  return counts_leave(data, d) ? d.leaveEpoch : d.depEpoch;
}

struct DepRef {
  const BoardView* b;
  const DepView* d;
};

static bool belongs(const BoardView& b, const char* station) {
  return strstr(b.origin, station) || strstr(b.destShort, station);
}

// Collect this station's catchable departures across ALL its boards, sort them
// by departure time, and only then keep the first `cap` — truncating before the
// sort would let one board's later trains crowd out another board's sooner ones.
static int collect_station(const BoardData& data, const char* station,
                           time_t now, DepRef* out, int cap) {
  DepRef all[36];  // 6 boards x 6 departures
  int n = 0;
  for (int i = 0; i < data.nBoards && i < 6; i++) {
    const BoardView& b = data.boards[i];
    if (!belongs(b, station)) continue;
    for (int j = 0; j < b.nDeps && j < 6; j++) {
      if (go_epoch(data, b.deps[j]) < now - CATCH_GRACE) continue;
      all[n++] = {&b, &b.deps[j]};
    }
  }
  for (int i = 1; i < n; i++) {  // insertion sort by depEpoch
    DepRef k = all[i];
    int j = i - 1;
    while (j >= 0 && all[j].d->depEpoch > k.d->depEpoch) {
      all[j + 1] = all[j];
      j--;
    }
    all[j + 1] = k;
  }
  if (n > cap) n = cap;
  for (int i = 0; i < n; i++) out[i] = all[i];
  return n;
}

static const BoardView* station_board(const BoardData& data,
                                      const char* station) {
  for (int i = 0; i < data.nBoards; i++)
    if (belongs(data.boards[i], station)) return &data.boards[i];
  return nullptr;
}

// Live state as it should be shown: a cancellation stays a cancellation, but
// delays / boarding go stale within minutes and are dropped on an old board.
static uint8_t shown_live(const DepView& d, bool liveFresh) {
  if (d.live == LIVE_CANCELLED) return LIVE_CANCELLED;
  return liveFresh ? d.live : (uint8_t)LIVE_NONE;
}

// "leave in 22 min" / "departs in 1h03" / "leave at 7:20a" (another day).
static void fmt_goin(const BoardData& data, const DepView& d, time_t now,
                     char* buf, size_t n) {
  const bool leave = counts_leave(data, d);
  const time_t go = go_epoch(data, d);
  if (day_index(go) != day_index(now) && go > now) {
    char clk[12];
    fmt_clock(go, clk, sizeof(clk), false);
    snprintf(buf, n, "%s at %s", leave ? "leave" : "departs", clk);
    return;
  }
  const char* verb = leave ? "leave" : "departs";
  long mins = (long)((go - now) / 60);
  if (mins <= 0)
    snprintf(buf, n, "%s now", verb);
  else if (mins < 60)
    snprintf(buf, n, "%s in %ld min", verb, mins);
  else
    snprintf(buf, n, "%s in %ldh%02ld", verb, mins / 60, mins % 60);
}

// "to New York" / "from Hoboken" / "" — only when a station's trains don't all
// share one destination (morning) or one city terminal (evening).
static void fmt_where(const DepRef& r, bool oneDest, bool oneOrigin, char* buf,
                      size_t n) {
  if (!oneDest)
    snprintf(buf, n, " to %s", dest_label(r.b->destShort));
  else if (!oneOrigin)
    snprintf(buf, n, " from %s", dest_label(r.b->origin));
  else
    buf[0] = 0;
}

// "catch the 12:23p, arrive 1:41p" (+ "to <dest>" / "from <origin>").
static void fmt_detail(const DepRef& r, bool oneDest, bool oneOrigin, char* buf,
                       size_t n) {
  char dp[12], ar[12], where[28];
  fmt_clock(r.d->depEpoch, dp, sizeof(dp), false);
  fmt_clock(r.d->arrEpoch, ar, sizeof(ar), false);
  fmt_where(r, oneDest, oneOrigin, where, sizeof(where));
  snprintf(buf, n, "catch the %s%s, arrive %s", dp, where, ar);
}

// --- live status ------------------------------------------------------------

// Exception text for a train that needs attention; empty when running normally.
static void fmt_exception(uint8_t live, int delayMin, char* buf, size_t n) {
  if (live == LIVE_CANCELLED)
    snprintf(buf, n, "CANCELLED");
  else if (live == LIVE_BOARDING)
    snprintf(buf, n, "ALL ABOARD");
  else if (live == LIVE_DELAYED && delayMin > 0)
    snprintf(buf, n, "+%d late", delayMin);
  else if (live == LIVE_DELAYED)  // delayed by an unknown amount
    snprintf(buf, n, "DELAYED");
  else
    buf[0] = 0;
}

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

// "Trk 3", right-aligned after the text already on the line — quiet, only when
// there's clear space for it.
static void draw_track(GFXcanvas1& c, const char* track, const GFXfont* lineFont,
                       const char* lineText, int y) {
  if (!track[0]) return;
  char buf[14];
  snprintf(buf, sizeof(buf), "Trk %s", track);
  const GFXfont* f = &FreeSans9pt7b;
  int need = PAD_L + text_w(c, lineFont, lineText) + 16 + text_w(c, f, buf);
  if (need <= RIGHT) draw_right(c, f, RIGHT, y, INK, buf);
}

// --- shared pieces ----------------------------------------------------------

static void draw_header(GFXcanvas1& c, const char* title, time_t now,
                        bool time_valid) {
  c.fillRect(0, 0, UI_W, HEADER_H, INK);
  char up[28];
  upper(up, sizeof(up), title);
  draw_left(c, &FreeSansBold12pt7b, PAD_L, 28, BG, up);
  if (time_valid) {
    char clk[16];
    fmt_clock(now, clk, sizeof(clk), true);
    draw_right(c, &FreeMonoBold12pt7b, RIGHT, 27, BG, clk);
  } else {
    draw_right(c, &FreeSans9pt7b, RIGHT, 27, BG, "syncing clock");
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

// --- station screen ---------------------------------------------------------

// The sub-line under the header: where the trains go / come from on the left,
// and — on a leave-the-house board — the drive time on the right. A missing
// drive time is called out, because it changes what the big number means.
static void draw_subline(GFXcanvas1& c, const BoardData& data,
                         const char* station, const DepRef* deps, int n) {
  const bool evening = data.mode == MODE_EVENING;
  char sub[48];
  sub[0] = 0;
  for (int i = 0; i < n; i++) {
    const char* dl =
        dest_label(evening ? deps[i].b->origin : deps[i].b->destShort);
    if (sub[0] && strstr(sub, dl)) continue;  // skip a place already listed
    size_t l = strlen(sub);
    snprintf(sub + l, sizeof(sub) - l, "%s%s",
             l ? " & " : (evening ? "from " : "to "), dl);
  }
  draw_left(c, &FreeSans9pt7b, PAD_L, Y_SUB, INK, sub);

  if (!data.showLeave) return;
  const BoardView* b = station_board(data, station);
  if (b && b->driveMin > 0) {
    char txt[24];
    snprintf(txt, sizeof(txt), "%s%d min drive",
             b->driveSource == DRIVE_EARLIER ? "~" : "", b->driveMin);
    draw_right(c, &FreeSans9pt7b, RIGHT, Y_SUB, INK, txt);
  } else if (b) {
    draw_tag(c, RIGHT, Y_SUB, "no drive time");
  }
}

static void draw_trains(GFXcanvas1& c, const BoardData& data, time_t now,
                        const char* station, const DepRef* deps, int n,
                        bool liveFresh) {
  draw_subline(c, data, station, deps, n);

  // Are all this station's trains headed to / coming from the same place?
  bool oneDest = true, oneOrigin = true;
  for (int i = 1; i < n; i++) {
    if (strcmp(deps[i].b->destShort, deps[0].b->destShort) != 0) oneDest = false;
    if (strcmp(deps[i].b->origin, deps[0].b->origin) != 0) oneOrigin = false;
  }

  // The hero is the next train that is actually running: cancelled trains
  // ahead of it are named beside the label so it's clear why it isn't first.
  int hero = 0;
  while (hero < n && deps[hero].d->live == LIVE_CANCELLED) hero++;
  const bool allCancelled = hero == n;
  if (allCancelled) hero = 0;

  const DepView& h = *deps[hero].d;
  const bool leave = counts_leave(data, h);
  const time_t go = go_epoch(data, h);
  const bool otherDay = day_index(go) != day_index(now) && go > now;
  const long mins = (long)((go - now) / 60);
  const bool due = mins <= 0;  // inside the last minute counts as "now"

  // --- label row -----------------------------------------------------------
  int labelEnd = PAD_L;
  if (allCancelled) {
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_LABEL, INK, "NEXT TRAIN");
    labelEnd += text_w(c, &FreeSans9pt7b, "NEXT TRAIN");
  } else if (otherDay) {
    // TOMORROW (dot) LEAVE AT — the day is the loudest word on the row.
    const char* what = leave ? "LEAVE AT" : "TRAIN DEPARTS AT";
    draw_left(c, &FreeSansBold9pt7b, PAD_L, Y_LABEL, INK, "TOMORROW");
    int x = PAD_L + text_w(c, &FreeSansBold9pt7b, "TOMORROW") + 9;
    c.fillCircle(x, Y_LABEL - 5, 2, INK);
    x += 9;
    draw_left(c, &FreeSans9pt7b, x, Y_LABEL, INK, what);
    labelEnd = x + text_w(c, &FreeSans9pt7b, what);
  } else {
    const char* label;
    if (leave) label = due ? "TIME TO GO" : "LEAVE IN";
    else if (data.showLeave) label = due ? "TRAIN DEPARTING" : "TRAIN DEPARTS IN";
    else label = due ? "DEPARTING" : "DEPARTS IN";
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_LABEL, INK, label);
    labelEnd += text_w(c, &FreeSans9pt7b, label);
  }
  if (!allCancelled && hero > 0) {
    char skipped[28];
    if (hero == 1) {
      char clk[12];
      fmt_clock(deps[0].d->depEpoch, clk, sizeof(clk), false);
      snprintf(skipped, sizeof(skipped), "%s CANCELLED", clk);
    } else {
      snprintf(skipped, sizeof(skipped), "%d trains CANCELLED", hero);
    }
    if (labelEnd + 16 + pill_w(c, skipped) <= RIGHT)
      draw_pill(c, RIGHT, Y_LABEL, skipped);
    else if (labelEnd + 16 + pill_w(c, "CANCELLED") <= RIGHT)
      draw_pill(c, RIGHT, Y_LABEL, "CANCELLED");
  }

  // --- hero ----------------------------------------------------------------
  char line[96];
  if (allCancelled) {
    draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO, INK, "cancelled");
    char dp[12], where[28];
    fmt_clock(h.depEpoch, dp, sizeof(dp), false);
    fmt_where(deps[hero], oneDest, oneOrigin, where, sizeof(where));
    snprintf(line, sizeof(line), "the %s%s is not running", dp, where);
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_DETAIL, INK, line);
  } else {
    if (otherDay) {
      char clk[12];
      struct tm tm;
      localtime_r(&go, &tm);
      int hr = tm.tm_hour % 12;
      if (hr == 0) hr = 12;
      snprintf(clk, sizeof(clk), "%d:%02d", hr, tm.tm_min);
      draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO, INK, clk);
      int nx = PAD_L + text_w(c, &FreeSansBold24pt7b, clk) + 8;
      draw_left(c, &FreeSansBold12pt7b, nx, Y_HERO, INK,
                tm.tm_hour < 12 ? "am" : "pm");
    } else if (due) {
      draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO, INK, "now");
    } else if (mins < 60) {
      char num[8];
      snprintf(num, sizeof(num), "%ld", mins);
      draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO, INK, num);
      int nx = PAD_L + text_w(c, &FreeSansBold24pt7b, num) + 10;
      draw_left(c, &FreeSansBold12pt7b, nx, Y_HERO, INK, "min");
    } else {
      char big[12];
      snprintf(big, sizeof(big), "%ldh%02ld", mins / 60, mins % 60);
      draw_left(c, &FreeSansBold24pt7b, PAD_L, Y_HERO, INK, big);
    }
    // Live status: exception pill beside the big number; track on the detail
    // line. The countdown stays on scheduled time — the pill is the alert.
    char badge[16];
    fmt_exception(shown_live(h, liveFresh), h.delayMin, badge, sizeof(badge));
    if (badge[0]) draw_pill(c, RIGHT, Y_HERO - 8, badge);

    fmt_detail(deps[hero], oneDest, oneOrigin, line, sizeof(line));
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_DETAIL, INK, line);
    if (liveFresh) draw_track(c, h.track, &FreeSans9pt7b, line, Y_DETAIL);
  }

  // --- up next: same phrasing, quieter ---------------------------------------
  if (hero + 1 >= n) return;
  {
    const char* lbl = "UP NEXT";
    draw_left(c, &FreeSans9pt7b, PAD_L, Y_NEXT + 5, INK, lbl);
    int lx = PAD_L + text_w(c, &FreeSans9pt7b, lbl) + 8;
    c.drawFastHLine(lx, Y_NEXT, UI_W - PAD_L - lx, INK);
  }
  int y = Y_ITEM;
  for (int i = hero + 1, shown = 0; i < n && shown < 2; i++, shown++) {
    const DepView& d = *deps[i].d;
    const uint8_t live = shown_live(d, liveFresh);
    char head[40], badge[16];
    if (live == LIVE_CANCELLED) {
      // No "leave in" for a train that isn't running.
      char dp[12], where[28];
      fmt_clock(d.depEpoch, dp, sizeof(dp), false);
      fmt_where(deps[i], oneDest, oneOrigin, where, sizeof(where));
      snprintf(head, sizeof(head), "the %s%s", dp, where);
      snprintf(line, sizeof(line), "not running");
    } else {
      fmt_goin(data, d, now, head, sizeof(head));
      fmt_detail(deps[i], oneDest, oneOrigin, line, sizeof(line));
    }
    draw_left(c, &FreeSansBold9pt7b, PAD_L, y, INK, head);
    fmt_exception(live, d.delayMin, badge, sizeof(badge));
    if (badge[0]) draw_pill(c, RIGHT, y - 2, badge);
    draw_left(c, &FreeSans9pt7b, PAD_L, y + 18, INK, line);
    if (liveFresh && live != LIVE_CANCELLED)
      draw_track(c, d.track, &FreeSans9pt7b, line, y + 18);
    y += ITEM_PITCH;
  }
}

// The server, freshly asked, has no trains for this station. Say so in the
// words of the board it sent — never "today" on tomorrow's board.
static void draw_no_trains(GFXcanvas1& c, const BoardData& data) {
  switch (data.mode) {
    case MODE_EVENING:
      draw_message(c, "No more direct trains tonight",
                   "No further arrivals on tonight's schedule.", "");
      break;
    case MODE_NEXT_MORNING:
      draw_message(c, "No direct trains tomorrow",
                   "Nothing from here on tomorrow's schedule.", "");
      break;
    default:
      draw_message(c, "No more direct trains today",
                   "Nothing further from here on today's schedule.", "");
  }
}

// --- entry ------------------------------------------------------------------

bool ui_degraded(const BoardData& data, time_t now, bool time_valid) {
  if (data.fetchedAt == 0 || data.nBoards == 0 || data.scheduleExpired)
    return true;
  return time_valid && board_age(data, now) > UI_STALE_SEC;
}

void ui_draw_notice(GFXcanvas1& canvas, const char* title, const char* line1,
                    const char* line2) {
  canvas.fillScreen(BG);
  canvas.setTextWrap(false);
  canvas.fillRect(0, 0, UI_W, HEADER_H, INK);
  draw_left(canvas, &FreeSansBold12pt7b, PAD_L, 28, BG, "FAMILY DASHBOARD");
  draw_message(canvas, title, line1, line2);
}

void ui_draw(GFXcanvas1& canvas, const BoardData& data, time_t now,
             net_state_t net, bool time_valid, UiScreen screen) {
  canvas.fillScreen(BG);
  canvas.setTextWrap(false);  // clip, never spill onto the next line
  const char* station =
      STATION_NAME[screen == SCREEN_BERNARDSVILLE ? 1 : 0];
  const bool wifiUp = net == NET_CONNECTED;

  // 1. No clock: every countdown would be wrong, so show none.
  if (!time_valid) {
    draw_header(canvas, station, now, false);
    draw_message(canvas, "Setting the clock",
                 wifiUp ? "Syncing the time over WiFi..."
                        : "Waiting for WiFi to set the time...",
                 "");
    return;
  }

  // 2. Never had a board: say which link in the chain is missing.
  if (data.fetchedAt == 0) {
    draw_header(canvas, "Family dashboard", now, true);
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

  draw_header(canvas, station, now, true);

  const long age = board_age(data, now);
  const bool offline = age > UI_OFFLINE_SEC;
  const bool liveFresh = age <= LIVE_FRESH_SEC;
  char since[20];
  fmt_since(data.fetchedAt, now, since, sizeof(since));

  DepRef deps[6];
  const int n = collect_station(data, station, now, deps, 6);

  // 3. Long out of touch: an old board with nothing left on it (or one from
  //    hours ago) is not "no trains" — it's "we don't know".
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
    draw_trains(canvas, data, now, station, deps, n, liveFresh);
  }

  // 5. Bottom band: how much to trust what's above.
  char foot[64];
  if (offline) {
    snprintf(foot, sizeof(foot), "OFFLINE since %s", since);
    draw_banner(canvas, foot);
  } else if (age > UI_STALE_SEC) {
    snprintf(foot, sizeof(foot), "%supdated %ld min ago, retrying",
             wifiUp ? "" : "WiFi down - ", age / 60);
    draw_footer(canvas, foot);
  } else if (data.scheduleExpired && n > 0) {
    draw_footer(canvas, "timetable out of date - live trains only");
  } else if (data.liveFeed == FEED_DOWN && data.mode != MODE_NEXT_MORNING &&
             n > 0) {
    draw_footer(canvas, "schedule only - no live status");
  }
}
