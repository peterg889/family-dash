# Family Dashboard — E-Ink firmware

Runs the family-dash "next trains" board on an **Elecrow CrowPanel ESP32
E-Paper 4.2"** (400×300 black/white). Over WiFi it fetches the live web app's
`/api/departures` (departures, live NJ Transit status and "leave by" times, all
computed server-side) and shows one screen per home station — **Morristown**
and **Bernardsville**. Each screen leads with a big **"leave in N min"** for
that station's next catchable train, then the drive time and what's up next.
The board's **up/down toggle** switches stations, and they also auto-rotate
every 30 s (`ROTATE_INTERVAL_MS`) with a full refresh.

NTP keeps the local clock. No API key lives on the device; it works anywhere
with WiFi (the endpoint is public HTTPS on Vercel).

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

- **LEAVE IN 12 min** — time until you must leave the house (train departure −
  drive − buffer). Shown only when the server says this is a leave-the-house
  board (`showLeave`) *and* sent a leave time for the train.
- **TRAIN DEPARTS IN** + a boxed **no drive time** — a leave-the-house board
  whose drive estimate is missing. The number is the train's departure, and the
  screen says so rather than quietly changing what the number means.
- **DEPARTS IN** — evening boards (city → home): the train leaving the city.
- **TOMORROW • LEAVE AT 6:52 am** — any train on a later calendar day is given
  as a clock time with the day spelled out, never as a 9-hour countdown.
- **~16 min drive** — the `~` marks a typical (not live-traffic) drive time.
- **Pills** (`+6 late`, `DELAYED`, `ALL ABOARD`, `CANCELLED`) are live NJ
  Transit status. A cancelled train is never the big number: the next running
  train is, with `7:38a CANCELLED` beside the label to show why.
- **Bottom band** — how far to trust the screen:

| Bottom band / screen                         | Meaning                                                       |
| -------------------------------------------- | ------------------------------------------------------------- |
| *(empty)*                                    | Board is fresh (< 6 min old), live status working             |
| `schedule only - no live status`             | Server couldn't reach NJ Transit's real-time feed             |
| `timetable out of date - live trains only`   | Server's timetable expired; only live-listed trains are shown |
| `updated 14 min ago, retrying`               | Fetches are failing (prefixed `WiFi down -` if that's why)    |
| **`OFFLINE since 9:41a`** (inverted bar)     | Board is > 30 min old: times are the last known schedule      |
| "Offline since 9:41a" (full screen)          | Board is > 3 h old, or old with no trains left on it          |
| "Schedule out of date" (full screen)         | Server's timetable expired and it has no trains to show       |
| "No WiFi" / "Reaching…" / "Can't reach the dashboard" | No board fetched since boot, and which link is missing |
| "Setting the clock"                          | NTP hasn't synced, so no countdown would be right             |
| "No more direct trains today / tonight / tomorrow" | The server, freshly asked, really had none              |

Live status ages fast, so once a board is more than 10 minutes old its delay /
boarding pills and track numbers are dropped rather than shown as current
(cancellations stay — a cancelled train doesn't un-cancel).

## Staying up unattended

- **Fetch cadence** — every `FETCH_INTERVAL_MS` (3 min) after a good fetch,
  `FETCH_RETRY_MS` (30 s) after a failed one, and immediately when WiFi
  reconnects or the clock is first set. New data is normally shown on the next
  rotate tick; if the screen was showing a problem, the fix is drawn at once.
- **Stale data is kept, and labelled** — a failed fetch never blanks the board;
  the last good one stays up with its age (see the table above).
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
board_api.{h,cpp}  fetch BOARD_API_URL over HTTPS, parse JSON (ArduinoJson,
                filtered to the fields used); a bad response never replaces a
                good board
board_data.h    parsed shape of /api/departures (boards, leave/depart/arrive,
                mode, showLeave, schedule/live health, fetch bookkeeping)
ui.{h,cpp}      draws the per-station screen and every failure state into a
                1-bit GFXcanvas1 (the single source of truth for panel +
                screenshots); no Arduino dependencies, so it builds natively
buttons.{h,cpp} up/down toggle (GPIO6/GPIO4) to switch stations
net.{h,cpp}     WiFi association + reconnect
ota.{h,cpp}     ArduinoOTA listener (only when OTA_PASSWORD is defined)
timekeeper.{h,cpp}  NTP sync + America/New_York (TZ EST5EDT,M3.2.0,M11.1.0)
config.h        API URL, fetch/rotate cadence, watchdog + reboot policy, NTP, TZ
wifi_config.h   WiFi creds + OTA password (gitignored; copy from
                wifi_config.example.h)
```

### JSON the firmware reads

From `/api/departures`: `now`, `mode`, `showLeave`, `headline`, `bufferMin`,
`status.schedule.expired`, `status.live`, and per board `origin`, `destShort`,
`driveMin`, `driveSource`, and per departure `leaveByEpochMs`, `depEpochMs`,
`arrEpochMs`, `live.state`, `live.delayMin`, `live.track`. Every field added
since the first version is optional: against an older server `showLeave` falls
back to "any leave time present", `mode` to the headline, and the health fields
to "unknown".

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
../tools/preview/render.sh --list                              # scenario names
../tools/preview/render.sh 0 out.png 2 1 cancelled-first       # [epoch|0] [out] [scale] [screen] [scenario]
../tools/preview/render-all.sh /tmp/screens                    # every scenario × both stations
```

`render-all.sh` exits non-zero if any scenario fails to build or render, so it
doubles as a smoke test (CI runs it; set `GFX_DIR` to an Adafruit-GFX-Library
checkout to build without PlatformIO's libdeps).

Serial commands (115200 baud on the CH340 port):

- `screenshot` — dump the framebuffer (used by `screenshot.sh`)
- `status` — one JSON line: uptime, WiFi state / IP / RSSI, heap, age of the
  last good fetch, last HTTP code, fail streak, board mode, build date
- `refresh` — force a full redraw (no refetch)
- `screen` — flip to the other station (also on the up/down toggle)
- `fetch` — refetch the API and redraw
- `settime <unix-seconds>` — inject a known clock and redraw, to verify the
  board at a specific time without waiting on NTP

## Changing what's shown

The board content — which routes, the drive times, the "leave by" math, the
morning/evening board selection — all comes from the **live web app**
(`BOARD_API_URL`), so change it there and the device follows. Point the device
at a different deployment by editing `BOARD_API_URL` in `src/config.h`.

There is deliberately **no schedule on the device**: an on-device timetable
goes out of date silently, which is exactly the failure this firmware is built
to avoid. Offline, it keeps showing the last board it fetched, with its age.

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
