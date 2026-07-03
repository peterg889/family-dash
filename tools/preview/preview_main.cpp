// Native preview of the E-Ink UI: builds a mock BoardData (weekday morning, both
// stations running) and renders a screen to a raw framebuffer, so the layout
// can be iterated without flashing or a network fetch.
// argv: [epoch] [out.raw] [screen 0=Morristown 1=Bernardsville]
#include <Adafruit_GFX.h>

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>

#include "ui.h"

static void mk(DepView& d, time_t base, long lv, long dp, long ar) {
  d.leaveEpoch = base + lv;
  d.depEpoch = base + dp;
  d.arrEpoch = base + ar;
}

int main(int argc, char** argv) {
  setenv("TZ", "EST5EDT,M3.2.0,M11.1.0", 1);
  tzset();
  time_t now = argc > 1 ? (time_t)atoll(argv[1]) : 1783332000;
  const char* out = argc > 2 ? argv[2] : "preview.raw";
  UiScreen screen =
      (argc > 3 && atoi(argv[3]) == 1) ? SCREEN_BERNARDSVILLE : SCREEN_MORRISTOWN;

  BoardData data{};
  strcpy(data.headline, "To NYC today");
  data.bufferMin = 5;
  data.ok = true;
  data.fetchedAt = now;
  data.nBoards = 3;

  strcpy(data.boards[0].origin, "Morristown");
  strcpy(data.boards[0].destShort, "Penn");
  data.boards[0].driveMin = 16;
  data.boards[0].nDeps = 2;
  mk(data.boards[0].deps[0], now, 720, 1980, 6560);   // leave in 12m
  mk(data.boards[0].deps[1], now, 4320, 5580, 10160);

  strcpy(data.boards[1].origin, "Bernardsville");
  strcpy(data.boards[1].destShort, "Penn");
  data.boards[1].driveMin = 9;
  data.boards[1].nDeps = 2;
  mk(data.boards[1].deps[0], now, 660, 1500, 6100);   // leave in 11m
  mk(data.boards[1].deps[1], now, 3160, 4000, 8600);

  strcpy(data.boards[2].origin, "Bernardsville");
  strcpy(data.boards[2].destShort, "Hoboken");
  data.boards[2].driveMin = 9;
  data.boards[2].nDeps = 2;
  mk(data.boards[2].deps[0], now, 1560, 2400, 5000);
  mk(data.boards[2].deps[1], now, 5000, 5840, 8440);

  GFXcanvas1 canvas(UI_W, UI_H);
  ui_draw(canvas, data, now, NET_CONNECTED, true, screen);

  size_t bytes = ((UI_W + 7) / 8) * UI_H;
  FILE* f = fopen(out, "wb");
  fwrite(canvas.getBuffer(), 1, bytes, f);
  fclose(f);
  fprintf(stderr, "wrote %s now=%lld screen=%d\n", out, (long long)now, screen);
  return 0;
}
