# Project context

Family Dashboard — an NJ Transit "next trains" board with two front-ends:

1. **Web app** (Next.js, `app/` `lib/` `scripts/`) — the deployed dashboard at
   `family-dash-beta.vercel.app`. Dark board with LEAVE / catch / arrive per
   train, Google-Maps traffic-aware drive times, a "leave by" column, and a
   Willow School commute tile. Time-of-day modes: morning (to NYC), evening
   (heading home), and next-morning.
2. **E-Ink device** (`firmware/`) — an Elecrow CrowPanel ESP32 E-Paper 4.2"
   (400×300 B/W) that **fetches the web app's `/api/departures`** and renders
   one screen per home station. It does not recompute the schedule; the server
   does the work (including the Maps drive times, with the key in Vercel env).

Deploy: `main` is the production branch (Vercel git integration). Push to `main`
→ auto-deploys → `family-dash-beta`. The Google Maps key lives in Vercel env
(`GOOGLE_MAPS_API_KEY`), never in the repo or on the device.

## Stations / boards

Morristown (92) and Bernardsville (18) × New York Penn (105) and Hoboken (63).
The board list and direction / day-part logic live in
`app/api/departures/route.ts`; `TRAINS_PER_BOARD` caps departures per board.
Bernardsville→NY often has no one-seat rides (most transfer at Summit), so an
empty board there is expected.

## Web app departures

`lib/departures.ts` (`nextDepartures`) + `lib/driving.ts` (Maps Routes API) are
the deployed logic. `data/schedule.json` is a GTFS-derived schedule built by
`scripts/build-schedule.mjs` (public NJ Transit feed, no API key). The service
day is anchored at GTFS "noon − 12h" (not local midnight), which matters on the
Nov 2026 DST fall-back.

## E-Ink firmware

See `firmware/README.md` for the full board spec, pinout, and gotchas. Key facts:

- Board: Elecrow CrowPanel ESP32 E-Paper 4.2" — ESP32-S3-WROOM-1-N8R8,
  SSD1683 panel, **CH340 USB** (`/dev/cu.usbserial*`, not `usbmodem*`).
- GxEPD2 class `GxEPD2_420_GYE042A87`. **GPIO7 = panel power-enable, must be
  HIGH before `display.init()`** or the screen stays blank.
- **Fetches the live board:** pulls `BOARD_API_URL` over HTTPS and renders one
  screen per home station (Morristown / Bernardsville): a big "leave in N min"
  hero + an "up next" list in the same leave-in / catch / arrive phrasing. The
  up/down toggle (GPIO6/4, `buttons.cpp`) switches stations; they also
  auto-rotate. NTP feeds the countdowns. Refetch every 3 min. `board_api.cpp`
  fetches + parses (ArduinoJson); `ui.cpp` renders into a 1-bit `GFXcanvas1`.
- Build/flash: `./flash-mac.sh` (needs `firmware/src/wifi_config.h`, gitignored).
- Self-QA: `screenshot` serial cmd → `./screenshot.sh out.png`; `fetch` forces a
  refetch; `settime <epoch>` injects a clock. Native design preview (renders
  `ui.cpp` on the host to a PNG): `tools/preview/render.sh`.
- `firmware/src/departures.cpp` + `schedule_data.h` are a self-contained on-device
  GTFS port, **excluded from the firmware build** (`build_src_filter`) — kept as
  a possible offline fallback and cross-validated by `tools/test/run.sh` (C++ ==
  a JS reference in `tools/test/ref.mjs`, plus a DST oracle). This port models a
  simpler schedule than the deployed web app; the device uses the live API, not
  this port.

Architecture mirrors the `waveshare/Clawdmeter` project (firmware/ + flash +
screenshot QA), adapted to E-Ink + a live-API-driven board.
