# Family Dashboard — E-Ink firmware

Runs the family-dash "next trains" board on an **Elecrow CrowPanel ESP32
E-Paper 4.2"** (400×300 black/white). It is a sign for someone **about to leave
the house for a train**: over WiFi it fetches the live web app's
`/api/departures` (trains to the city, live NJ Transit status and "leave by"
times, all computed server-side) and shows **one combined screen** — every
train to the city from both home stations (Morristown and Bernardsville), in
the order you'd have to leave for them. The next one you can still catch gets a
big **"leave in N min"** and the clock time to leave by; the ones after it sit
below, one line each. The board's **up/down toggle** pages to later trains.

It never shows trains home, and it only redraws when the picture changes — once
a minute by day, hardly at all overnight.

NTP keeps the local clock (the server's own clock is the fallback). No API key
lives on the device; it works anywhere with WiFi (the endpoint is public HTTPS
on Vercel).

|         |                                                  |
| ------- | ------------------------------------------------ |
| Board   | Elecrow CrowPanel ESP32 E-Paper 4.2" (DIE07300S) |
| MCU     | ESP32-S3-WROOM-1-N8R8 (8 MB flash / 8 MB PSRAM)  |
| Panel   | SSD1683, 400×300 B/W, SPI (write-only)           |
| USB     | CH340 bridge → `/dev/cu.usbserial*`              |
| Library | GxEPD2 (`GxEPD2_420_GYE042A87`), ArduinoJson 7   |

## Quick start

```bash
cp src/wifi_config.example.h src/wifi_config.h
$EDITOR src/wifi_config.h              # WIFI_SSID / WIFI_PASS (2.4 GHz), OTA_PASSWORD
../flash-mac.sh                        # build + flash over USB (auto-detects the port)
../flash-ota.sh                        # ...afterwards: build + flash over WiFi
```

On boot it joins WiFi, syncs the clock over NTP, fetches the board, and renders
it. The API URL is `BOARD_API_URL` in `src/config.h`.

## What the screen means

```text
 TO THE CITY                       ● 7:05 AM     ● = live NJ Transit data, fresh
 LEAVE IN                        16 min drive
 11 min                             by 7:16a     big number + the time to leave by
 Morristown 7:38a → Penn 8:54a      [+6 late]    which station, which train
 LEAVE BY ─────────────────────────────────
 7:30a  Bernardsville 7:45 → Hoboken 8:28a       later trains: leave-by first
 7:46a  Morristown    8:08 → Penn 9:24a
 ...
 ! M&E trains are subject to...          2/4     bottom band
```

- **LEAVE IN 12 min · by 7:17a** — time until you must leave the house (train
  departure − drive − buffer), and that moment as a clock time. Leave times are
  floored to the minute, so the two always agree and everything on the screen
  ticks together, on the minute.
- **LEAVE AT 7:16 am** — the same, when it is more than 90 minutes off (or at
  night): a clock time instead of a countdown, so the screen isn't redrawn every
  minute for a train hours away. For a later day it reads
  **TOMORROW • LEAVE AT**, under a **TOMORROW** header.
- **TRAIN DEPARTS IN** + a boxed **no drive time** — the server has no drive
  estimate. The number is then the train's departure, and the screen says so
  rather than quietly changing what the number means. The first column of the
  rows becomes **DEPARTS**.
- **The station name is the largest word on the train line** — which station
  to drive to is the thing not to get wrong.
- **~16 min drive** — the `~` marks a drive time Google measured earlier (it is
  only re-measured during the morning hours), rather than in the last few minutes.
- **Rows** — `leave-by  station  train-time → destination arrival`. The train's
  own time has no am/pm; it is minutes after the leave-by beside it. Up to five
  rows; the toggle pages to later ones (`later 2/3`) and it returns to the first
  page by itself after a minute.
- **Pills** are live NJ Transit status: `+6 late` (only for delays of 3 minutes
  or more), `DELAYED`, `ALL ABOARD`, `CANCELLED`; compact in the rows (`+8`,
  `LATE`, `BOARDING`). A cancelled train is never the big number — the next
  running one is — and stays in the list struck through. Track numbers are not
  shown: at the home stations it is always the same platform.
- **Bottom band** — how far to trust the screen, then anything NJ Transit wants
  riders to know:

| Bottom band / screen                         | Meaning                                                       |
| -------------------------------------------- | ------------------------------------------------------------- |
| *(empty)*                                    | Board is fresh (< 6 min old), live status working             |
| `! M&E trains are subject to…   2/4`         | NJ Transit service alert; a long one steps a line per minute  |
| `schedule only - no live status`             | Server couldn't reach NJ Transit's real-time feed             |
| `timetable out of date - live trains only`   | Server's timetable expired; only live-listed trains are shown |
| `updated 14 min ago, retrying`               | Fetches are failing (prefixed `WiFi down -` if that's why)    |
| **`OFFLINE since 9:41a`** (inverted bar)     | Board is > 30 min old: the stored trains keep counting down   |
| "Offline since 9:41a" (full screen)          | No stored train is left, or the board is > 12 h old           |
| "Schedule out of date" (full screen)         | Server's timetable expired and it has no trains to show       |
| "No WiFi" / "Reaching…" / "Can't reach the dashboard" | No board fetched since boot, and which link is missing |
| "Setting the clock"                          | No time from NTP or the server yet, so no countdown is right  |
| "No more direct trains today / tomorrow morning" | The server, freshly asked, really had none                |

Live status ages fast, so once a board is more than 10 minutes old its delay /
boarding pills are dropped rather than shown as current (cancellations stay — a
cancelled train doesn't un-cancel).

**Night (11 PM – 5 AM):** no clock in the header and no countdowns, so the
picture only changes when the trains do; the board is refetched every 15 min
instead of 3, and the staleness limits stretch to match.

## Staying up unattended

- **Fetch cadence** — every `FETCH_INTERVAL_MS` (3 min) after a good fetch
  (`FETCH_INTERVAL_NIGHT_MS`, 15 min, at night), `FETCH_RETRY_MS` (30 s) after a
  failed one, and immediately when WiFi reconnects or the clock is first set.
- **Redraw only on change** — the screen is rendered into memory every few
  seconds and on the minute, and pushed to the panel (a full refresh) only when
  it differs from what the panel already shows.
- **Keeps working offline** — the sign asks for 12 trains per board
  (`limit=12`) and holds them, so if WiFi or the server goes away the
  countdowns carry on for hours under an OFFLINE banner. A failed fetch never
  blanks the board.
- **Clock from the server** — if NTP can't be reached, the first good fetch
  sets the clock from the response's `now`; NTP corrects it when it can.
- **Watchdog** — a 60 s task watchdog (`WDT_TIMEOUT_S`) resets the chip if
  `loop()` hangs. Every phase of a fetch is time-bounded (connect 6 s, TLS
  handshake 10 s, response 8 s) so a slow network can't trip it.
- **Nightly reboot** at 3:30 AM local (only when up > 6 h).
- **Stuck-network reboot** — if WiFi is "connected" but no HTTP exchange has
  completed for 30 min, or WiFi can't associate for 30 min. Never within the
  first hour of uptime, so at most once an hour. (If the server is answering
  with errors the device is healthy, so it keeps showing the old board instead.)

## Over-the-air updates

With `OTA_PASSWORD` defined in `src/wifi_config.h` the board listens for
updates as `family-dash-eink.local` (ArduinoOTA, port 3232):

```bash
../flash-ota.sh                 # build, then upload over WiFi
../flash-ota.sh 192.168.1.57    # same, addressing the board by IP
```

The screen shows "Updating firmware…" and the board reboots into the new build.
The first OTA-enabled build has to go on over USB. The board connects *back* to
the laptop to fetch the image, so macOS may ask to allow incoming connections
for python. Leave `OTA_PASSWORD` undefined to disable OTA entirely.

## Pinout (this board)

| Signal           | GPIO  |     | Signal   | GPIO |
| ---------------- | ----- | --- | -------- | ---- |
| EPD power-enable | **7** |     | EPD CS   | 45   |
| EPD SCK          | 12    |     | EPD DC   | 46   |
| EPD MOSI (DIN)   | 11    |     | EPD RST  | 47   |
| (no MISO)        | −1    |     | EPD BUSY | 48   |
| Toggle up        | 6     |     | Toggle down | 4 |

**GPIO7 must be driven HIGH before `display.init()`** or the panel gets no
power and stays blank — the #1 gotcha for this board. See `src/display_cfg.h`.

## Architecture

```text
main.cpp        setup()/loop(): panel power + GxEPD2 init, fetch scheduling,
                render loop, watchdog / nightly + stuck-network reboot,
                serial commands
display_cfg.h   pin map + GxEPD2 display type/instance
board_api.{h,cpp}  fetch BOARD_API_URL over HTTPS
board_parse.{h,cpp}  the JSON -> BoardData parser (ArduinoJson, filtered to the
                fields used). No Arduino dependencies, so the same file is
                built on a laptop for the preview and the contract check; a bad
                response never replaces a good board
board_data.h    parsed shape of /api/departures (boards, leave/depart/arrive,
                mode, showLeave, schedule/live health, fetch bookkeeping)
ui.{h,cpp}      draws the combined screen and every failure state into a
                1-bit GFXcanvas1 (the single source of truth for panel +
                screenshots); no Arduino dependencies, so it builds natively
fonts/          the 48 pt countdown face (generated from GNU FreeSans Bold)
buttons.{h,cpp} up/down toggle (GPIO6/GPIO4) to page through later trains
net.{h,cpp}     WiFi association + reconnect
ota.{h,cpp}     ArduinoOTA listener (only when OTA_PASSWORD is defined)
timekeeper.{h,cpp}  NTP sync + America/New_York (TZ EST5EDT,M3.2.0,M11.1.0)
config.h        API URL, fetch/render cadence, watchdog + reboot policy, NTP, TZ
wifi_config.h   WiFi creds + OTA password (gitignored; copy from
                wifi_config.example.h)
```

### JSON the firmware reads

The sign fetches `/api/departures?direction=outbound&limit=12&device=eink`.
`firmware/api-fields.json` is the authoritative list of what it reads from the
response (the server's tests assert every one is present): `now`, `mode`,
`showLeave`, `headline`, `status.schedule.expired`, `status.live`,
`alerts[].text`, and per board `origin`, `destShort`, `driveMin`,
`driveSource`, and per departure `leaveByEpochMs`, `depEpochMs`, `arrEpochMs`,
`live.state`, `live.delayMin`. Fields added since the first version are
optional: against an older server `showLeave` falls back to "any leave time
present", `mode` to the headline, and the health fields to "unknown".

**Contract check** — the parser is plain C++, so a real response can be run
through the device's own code on a laptop:

```bash
../tools/contract/check.sh api.json [out.png]   # exit 1 unless the sign could use it
```

It fails unless the response yields at least one board with a train whose times
are sane, `mode` / `showLeave` / `status.live` were read the way they are
written, and a train is still catchable at the response's own `now`; it also
renders the screen from it. CI runs it against a response produced by the
server's own code, so the two can't drift apart unnoticed.

## QA without looking at the screen

The firmware renders into a 1-bit canvas and can dump it over serial, so UI
changes can be verified from the host:

```bash
../screenshot.sh out.png                 # capture the current framebuffer → PNG
```

For **design iteration without flashing**, the UI renders natively to a PNG via
a small Arduino shim — edit `src/ui.cpp` and see the result in ~2 s. Every
state the screen can be in has a named scenario:

```bash
../tools/preview/render.sh --list                           # scenario names
../tools/preview/render.sh 0 out.png 2 "" cancelled-first   # [epoch|0] [out] [scale] [page] [scenario]
../tools/preview/render-all.sh /tmp/screens                 # every scenario
../tools/preview/render.sh --json api.json out.png          # a REAL response, via the device's parser
```

`render-all.sh` exits non-zero if any scenario fails to build or render, so it
doubles as a smoke test (CI runs it). Both it and the contract check build
against PlatformIO's libdeps (`pio run -d firmware` once); set `GFX_DIR` /
`ARDUINOJSON_DIR` to build without them.

Serial commands (115200 baud on the CH340 port):

- `screenshot` — dump the framebuffer (used by `screenshot.sh`)
- `status` — one JSON line: uptime, WiFi state / IP / RSSI, heap, age of the
  last good fetch, last HTTP code, fail streak, board mode, trains held, page,
  number of panel refreshes and time since the last one, night flag, build date
- `refresh` — force a full redraw (no refetch)
- `page` / `page <n>` — next page of later trains / a given page (also on the
  up/down toggle)
- `fetch` — refetch the API and redraw
- `settime <unix-seconds>` — inject a known clock and redraw, to verify the
  board at a specific time without waiting on NTP

## Changing what's shown

The board content — which routes, the drive times, the "leave by" math, today
vs. tomorrow morning — all comes from the **live web app**
(`BOARD_API_URL`), so change it there and the device follows. Point the device
at a different deployment by editing `BOARD_API_URL` in `src/config.h`.

There is deliberately **no schedule on the device**: an on-device timetable
goes out of date silently, which is exactly the failure this firmware is built
to avoid. Offline, it keeps showing the trains from the last board it fetched
(up to 12 per route), marked OFFLINE with the time it lost touch.

## Gotchas specific to this board

1. **GPIO7 power-enable HIGH before init** (see above).
2. **SPI must be remapped** — the ESP32-S3 default SPI pins are not the panel
   pins: `SPI.begin(12, -1, 11, 45)` before `display.init()`.
3. **PSRAM = `qio_opi`** (quad flash + octal PSRAM), not `opi_opi`/`qio_qspi`.
4. **Flash over the CH340** (`/dev/cu.usbserial*`, not `usbmodem*`).
   `upload_speed = 460800` is reliable; 921600 is flaky on this bridge.
5. **`ARDUINO_USB_CDC_ON_BOOT=0`** so `Serial` stays on UART0/CH340 — with
   CDC-on-boot you get no serial output and the screenshot dump breaks.
6. E-Ink ghosts under partial refreshes; every station screen is drawn with a
   full (flashing) refresh, which keeps the panel clean. Only the transient
   "Updating firmware…" notice uses a fast partial update.
