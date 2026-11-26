# Project context

Family Dashboard — an NJ Transit "next trains" board with two front-ends:

1. **Web app** (Next.js, `app/` `lib/` `scripts/`) — the deployed dashboard at
   `family-dash-beta.vercel.app`. Dark board with LEAVE / catch / arrive per
   train, a "leave by" column, and an optional second drive-time tile (the
   school run; `COMMUTE_NAME` / `COMMUTE_ADDRESS`). Time-of-day
   modes: morning (to NYC), evening (heading home), and next-morning.
2. **E-Ink device** (`firmware/`) — an Elecrow CrowPanel ESP32 E-Paper 4.2"
   (400×300 B/W) that **fetches the web app's `/api/departures`** and renders
   one screen per home station. It does not compute anything itself; the server
   does the work.

Deploy: `main` is the production branch (Vercel git integration). Push to `main`
→ auto-deploys → `family-dash-beta`. Secrets and anything private live in Vercel
env, never in the repo or on the device: `HOME_ADDRESS`, `COMMUTE_NAME` /
`COMMUTE_ADDRESS`, `GOOGLE_MAPS_API_KEY`, `NJT_API_USERNAME` / `NJT_API_PASSWORD` (see
`.env.example`). Production values are "sensitive" (unreadable); the
*development* environment has readable copies — `vercel env pull .env.local`
gets working NJT credentials for local testing. **The repo is public: never
commit an address, a place name that locates the family (home, school), a key,
or a credential — and never return one from the API.** The history was rewritten
on 2026-11-25 to remove the home address and the school.

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

**Login budget:** `getToken` is capped at ~5/day. One token lives in Vercel's
Runtime Cache (`getCache()` — shared across instances *and deployments*; Next's
`unstable_cache` keys change with every build, which cost a login per deploy)
and is reused until the API explicitly says "Invalid token". Logins are counted
per day in the same cache, max 3/day; a timeout or 5xx must never trigger a
login, and a deployed instance without the shared cache refuses to log in.
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

## Drive times (measured by Google, never guessed)

The owner wants drive times accurate or absent — **do not add hand-typed or
"typical" fallbacks.** `lib/driving.ts`: every figure is a Google Routes
traffic-aware measurement. During `DRIVE_LIVE_HOURS` (default 6–8 AM NY) each
destination is re-measured about every 5 minutes; outside them nothing is
measured and the most recent measurement is shown (one is taken off-hours only
if the last is over ~26 h old or missing). ≤ 72 Google calls/day. Measurements
and the one-attempt-per-slot guard live in Vercel's Runtime Cache
(`getCache()` from `@vercel/functions`), shared across instances. The API marks
each board `driveSource: "live" | "earlier"` plus `driveMeasuredAtMs`; screens
show earlier as "~16 min". If Google has never answered there is no drive time
and no leave-by, and the screens say "no drive time". Failures log
`[drive] Google Routes failed … <reason>`. The home address is only ever sent to
Google and is never in the API response.

## API contract (`/api/departures`)

Query: `direction=outbound|inbound` pins the direction (default: by time of day);
`limit=1..16` trains per board (default 5); `device=eink` marks the request as
the sign checking in. **The sign always asks for
`?direction=outbound&limit=12&device=eink`** — it is at home and only looked at
when leaving for the train, so it never shows trains home (owner's decision; so
is: no transfers, no Morristown→Hoboken, no pickup view).

`mode` (`morning` | `evening` | `next-morning`), `showLeave`, `headline`,
`status: { schedule: {validThrough, daysLeft, expired}, live: ok|down|off,
drive: live|earlier|none|off }`, `commute`, and `boards[]` each with
`driveMin`, `driveSource`, `driveMeasuredAtMs`, `source` and `departures[]` (`depEpochMs`,
`arrEpochMs`, `leaveByEpochMs`, `train`, `source: live|schedule`, `live`).
Also `alerts[]` (`{text, urgent}`; `urgent` = it says trains are affected AND it is
about the owner's lines or names no line — other lines' alerts show up on the
big terminals' boards — NJ Transit's station messages, which arrive with
the boards at no extra cost) and `status.device.lastSeenMs` (the sign's last
check-in). `?now=<epochMs>` overrides the clock for testing; it never touches
live data and is never cached. Responses are edge-cached for 15 s.

**The sign's contract is tested:** `firmware/api-fields.json` lists every field
the firmware reads; `tests/contract.test.ts` checks the response has them all
and still matches `tests/fixtures/api-outbound-sample.json`
(`npm run contract:update` regenerates it); CI runs the firmware's real parser
and renderer over that sample (`tools/contract/check.sh`).

## Knowing when it breaks

`.github/workflows/health.yml` runs `scripts/health-check.mjs` hourly against
production and opens one GitHub issue ("Train board needs attention") when
something is wrong — closing it when it recovers. Station boards are also cached
in the Runtime Cache (45 s), so NJ Transit calls have a hard ceiling regardless
of traffic.

## E-Ink firmware

See `firmware/README.md` for the full board spec, pinout, and gotchas. Key facts:

- Board: Elecrow CrowPanel ESP32 E-Paper 4.2" — ESP32-S3-WROOM-1-N8R8,
  SSD1683 panel, **CH340 USB** (`/dev/cu.usbserial*`, not `usbmodem*`).
- GxEPD2 class `GxEPD2_420_GYE042A87`. **GPIO7 = panel power-enable, must be
  HIGH before `display.init()`** or the screen stays blank.
- **It only draws what the server sends.** `board_api.cpp` fetches
  `BOARD_API_URL` (`?direction=outbound&limit=12&device=eink`); `board_parse.cpp`
  — Arduino-free, so the laptop and CI run the very same parser
  (`tools/contract/check.sh`) — fills a temp struct, so a bad response never
  replaces a good board. `firmware/api-fields.json` lists every field it reads;
  keep it in step with the parser.
- **One combined screen** (`ui.cpp`, 1-bit `GFXcanvas1`): every train to the city
  from both stations, ordered by when you have to leave the house. A 48 pt
  countdown ("LEAVE IN 11 min") plus "by 7:16a" for the next catchable train;
  beyond 90 minutes, on a later day, and all night it shows the clock time
  instead ("TOMORROW • LEAVE AT 6:08 am"). Below it, four roomy one-line rows:
  leave-by, station, train → destination … arrival (four, not five: the owner
  found five cluttered, but wants the arrival time kept on every row). The
  destination starts right after the arrow and the arrival time is
  right-aligned, so neither shifts with the other's width (owner's request). No track numbers;
  delay pills only from 3 minutes; a cancelled train is struck through and never the hero. Up/down
  pages through later trains and returns by itself after 60 s. It never shows
  trains home, transfers, or a pickup view (owner's decisions).
- **Bottom band**, by priority: OFFLINE banner (>30 min) · "updated N min ago"
  (>6 min) · NJ Transit alert, one line, only if the server marks it `urgent`
  (it says trains are affected — the owner doesn't want bus or general notices,
  on the sign or the web page) · "schedule only
  - no live status" · "timetable out of date". WiFi down, server unreachable,
  expired timetable and "setting the clock" each have their own full screen —
  it never says "no trains" for a different problem.
- **Redraws only when the picture changes** (so once a minute by day; the owner
  is fine with full-refresh flashes). Night is 11 PM–5 AM: no clock in the
  header, clock times instead of countdowns, fetch every 15 min — the panel
  normally doesn't refresh at all.
- **Staying alive unattended** (`main.cpp`, constants in `config.h`): fetch every
  3 min, 30 s after a failure, and at once when WiFi reconnects or the clock is
  first set; clock taken from the server's `now` if NTP hasn't answered; holds
  12 trains per board and keeps showing them under the OFFLINE banner for up
  to 12 h; 60 s task watchdog; reboot nightly at 3:30 AM; reboot when the
  network is wedged for 30 min (at most hourly).
- Build/flash over USB: `./flash-mac.sh` (needs `firmware/src/wifi_config.h`,
  gitignored — WiFi credentials and `OTA_PASSWORD`). After that, **over WiFi**:
  `./flash-ota.sh` (`family-dash-eink.local`, or pass the IP).
  `platformio.ini` pins the platform and library versions.
- Self-QA: serial commands `screenshot` (→ `./screenshot.sh out.png`), `status`
  (one JSON line), `fetch`, `refresh`, `settime <epoch>`. Design without the
  device: `tools/preview/render.sh <scenario>` or `--json <api-response.json>`;
  `tools/preview/render-all.sh <dir>` renders every scenario (CI runs it and
  uploads the PNGs).

Architecture mirrors the `waveshare/Clawdmeter` project (firmware/ + flash +
screenshot QA), adapted to E-Ink + a live-API-driven board.
