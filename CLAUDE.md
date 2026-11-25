# Project context

Family Dashboard — an NJ Transit "next trains" board with two front-ends:

1. **Web app** (Next.js, `app/` `lib/` `scripts/`) — the deployed dashboard at
   `family-dash-beta.vercel.app`. Dark board with LEAVE / catch / arrive per
   train, a "leave by" column, and a School commute tile. Time-of-day
   modes: morning (to NYC), evening (heading home), and next-morning.
2. **E-Ink device** (`firmware/`) — an Elecrow CrowPanel ESP32 E-Paper 4.2"
   (400×300 B/W) that **fetches the web app's `/api/departures`** and renders
   one screen per home station. It does not compute anything itself; the server
   does the work.

Deploy: `main` is the production branch (Vercel git integration). Push to `main`
→ auto-deploys → `family-dash-beta`. Secrets and anything private live in Vercel
env, never in the repo or on the device: `HOME_ADDRESS`, `DRIVE_TYPICAL_MIN`,
`GOOGLE_MAPS_API_KEY`, `NJT_API_USERNAME` / `NJT_API_PASSWORD` (see
`.env.example`). Production values are "sensitive" (unreadable); the
*development* environment has readable copies — `vercel env pull .env.local`
gets working NJT credentials for local testing. **The repo is public: never
commit an address, key, or credential.**

Checks: `npm test` (vitest), `npm run typecheck`, `npm run build`.
`.github/workflows/ci.yml` runs those plus a firmware compile and a render of
every E-Ink screen state on each push.

## Stations / boards

Morristown (92) and Bernardsville (18) × New York Penn (105) and Hoboken (63).
The board list and direction / day-part logic live in
`app/api/departures/route.ts`; `TRAINS_PER_BOARD` caps departures per board.
Bernardsville→NY has only a couple of one-seat rides a day (most transfer at
Summit), so an empty board there is expected. Morristown→Hoboken trips exist in
the data but no board shows them.

## How a board is built ("live first")

`lib/board.ts` (`buildBoard`) merges two sources:

- **NJ Transit's live board** for the *home* station (`lib/njtransit.ts`,
  `getTrainSchedule` — the full variant, whose trains carry their stop lists).
  One call per home station covers both directions with departure *and* arrival
  times. For as far ahead as that board reaches (its next ~19 trains, usually
  4–8 h) the trains shown are exactly the ones NJ Transit lists: a timetable
  train that isn't there is dropped, a listed train missing from the timetable
  is added. This is what handles adjusted / emergency schedules. Stop `DEP_TIME`
  is the scheduled time, `TIME` the estimate; boards show the scheduled minute.
- **The bundled timetable** `data/schedule.json` (`lib/departures.ts`,
  `nextDepartures`) beyond the live window, for the next-morning preview, and
  whenever live data is unavailable.

Wrinkles handled there: a train that *terminates* at the home station never
appears on that station's departure board (trips carry `ends: true`, so they
aren't dropped); in the evening the home board's status/track describe arrival
at home, so track and "boarding" come from the city station's light board
(`getTrainSchedule19Rec`) instead; a live board with fewer than 3 usable trains
is not trusted to remove anything. Live trains are joined to timetable trains by
**train number** (GTFS `block_id` == live `TRAIN_ID`, zero-padding normalized).

NJT quirks: `SEC_LATE` of `-60` is a "no estimate yet" sentinel (not early); a
blank `STATUS` is normal; `TRACK` "Single" (Gladstone branch) is not surfaced;
a rejected token is HTTP 500 `{"errorMessage":"Invalid token."}`.

**Login budget:** `getToken` is capped at ~5/day. Tokens are cached in Next's
Data Cache keyed by (service day, attempt); only an explicit "Invalid token"
advances the attempt, max 3/day. A timeout or 5xx must never trigger a login.
When testing by hand, mint once and reuse the token — don't loop on `getToken`.

## Timetable

`data/schedule.json` is built by `scripts/build-schedule.mjs` from NJ Transit's
own GTFS zip (`njtransit.com/rail_data.zip`; the Mobility Database mirror is a
stale fallback). It covers only a few months of service dates.
`.github/workflows/refresh-schedule.yml` rebuilds it daily, commits when the
trains change, and fails loudly under 14 days left. The API reports validity in
`status.schedule` and both screens show "timetable out of date" when expired.
The service day is anchored at GTFS "noon − 12h" (not local midnight) — that is
what keeps the two daylight-saving Sundays right; `tests/departures.test.ts`
pins it.

## Drive times ("typical first")

`lib/driving.ts`: `DRIVE_TYPICAL_MIN` (e.g. `92=16,18=10,commute=15`) gives every
train a leave-by with no outside dependency. Live Google Routes traffic is an
optional refinement — asked only for today's outbound boards during
`DRIVE_LIVE_HOURS` (default 5–11 NY), once per destination per 10-minute slot
via the shared cache (≤ ~108 calls/day). Any failure falls back to typical and
logs the reason. The API marks each board `driveSource: "live" | "typical"`;
screens show typical as "~16 min". The home address is only ever sent to Google
and is never in the API response.

## API contract (`/api/departures`)

`mode` (`morning` | `evening` | `next-morning`), `showLeave`, `headline`,
`status: { schedule: {validThrough, daysLeft, expired}, live: ok|down|off,
drive: live|typical|none|off }`, `commute`, and `boards[]` each with
`driveMin`, `driveSource`, `source` and `departures[]` (`depEpochMs`,
`arrEpochMs`, `leaveByEpochMs`, `train`, `source: live|schedule`, `live`).
`?now=<epochMs>` overrides the clock for testing; it never touches live data
and is never cached. Responses are edge-cached for 15 s.

## E-Ink firmware

See `firmware/README.md` for the full board spec, pinout, and gotchas. Key facts:

- Board: Elecrow CrowPanel ESP32 E-Paper 4.2" — ESP32-S3-WROOM-1-N8R8,
  SSD1683 panel, **CH340 USB** (`/dev/cu.usbserial*`, not `usbmodem*`).
- GxEPD2 class `GxEPD2_420_GYE042A87`. **GPIO7 = panel power-enable, must be
  HIGH before `display.init()`** or the screen stays blank.
- **It only draws what the server sends.** `board_api.cpp` fetches
  `BOARD_API_URL` over HTTPS and parses it (ArduinoJson, filtered) into a temp
  struct, so a bad response never replaces a good board. `ui.cpp` renders one
  screen per home station into a 1-bit `GFXcanvas1`: a big "leave in N min" hero
  + an "up next" list. The up/down toggle (GPIO6/4) switches stations; they also
  auto-rotate every 30 s with a full refresh (the owner is fine with that).
  There is no on-device schedule.
- **What the screen promises** (all covered by preview scenarios):
  `showLeave` from the server — not the presence of a leave time — decides
  LEAVE IN vs TRAIN DEPARTS IN, and a missing drive time is called out; a
  cancelled train is never the hero; trains on a later day read
  "TOMORROW • LEAVE AT 6:32am"; a typical drive time is drawn "~16 min drive".
  The bottom band reports degraded data: "updated 14 min ago" (>6 min),
  an inverted "OFFLINE since 9:41a" banner (>30 min), "schedule only — no live
  status", "timetable out of date". It never shows "no trains" when the real
  problem is WiFi, the server, or an expired timetable — each has its own screen.
- **Staying alive unattended** (`main.cpp`, constants in `config.h`): fetch every
  3 min, 30 s after a failure, and at once when WiFi reconnects or the clock is
  first set; 60 s task watchdog; reboot nightly at 3:30 AM; reboot when the
  network is wedged for 30 min (at most hourly).
- Build/flash over USB: `./flash-mac.sh` (needs `firmware/src/wifi_config.h`,
  gitignored — WiFi credentials and `OTA_PASSWORD`). After that, **over WiFi**:
  `./flash-ota.sh` (`family-dash-eink.local`, or pass the IP).
  `platformio.ini` pins the pioarduino platform (Arduino core 3.3.x).
- Self-QA: serial commands `screenshot` (→ `./screenshot.sh out.png`), `status`
  (one JSON line: uptime, RSSI, heap, last fetch, HTTP code), `fetch`, `refresh`,
  `screen`, `settime <epoch>`. Design without the device:
  `tools/preview/render.sh` renders `ui.cpp` on the host;
  `tools/preview/render-all.sh <dir>` renders every scenario (CI runs it).

Architecture mirrors the `waveshare/Clawdmeter` project (firmware/ + flash +
screenshot QA), adapted to E-Ink + a live-API-driven board.
