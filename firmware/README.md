# Family Dashboard — E-Ink firmware

Runs the family-dash "next trains" board on an **Elecrow CrowPanel ESP32
E-Paper 4.2"** (400×300 black/white). Over WiFi it fetches the live web app's `/api/departures` (departures **plus**
traffic-aware "leave by" times computed server-side via Google Maps) and shows
one screen per home station — **Morristown** and **Bernardsville**. Each screen
leads with a big **"leave in N min"** for that station's next catchable train,
then the destination, the traffic drive time, and what's up next. The board's
**up/down toggle** switches stations (and they also auto-rotate every 30 s,
`ROTATE_INTERVAL_MS`).

NTP keeps the local clock. No local server or API key on the device; it works
anywhere with WiFi (the endpoint is public HTTPS on Vercel).

|                               |                                            |
| ----------------------------- | ------------------------------------------ |
| Board                         | Elecrow CrowPanel ESP32 E-Paper 4.2" (DIE07300S) |
| MCU                           | ESP32-S3-WROOM-1-N8R8 (8 MB flash / 8 MB PSRAM) |
| Panel                         | SSD1683, 400×300 B/W, SPI (write-only)     |
| USB                           | CH340 bridge → `/dev/cu.usbserial*`        |
| Library                       | GxEPD2 (`GxEPD2_420_GYE042A87`)            |

## Quick start

```bash
cp src/wifi_config.example.h src/wifi_config.h
$EDITOR src/wifi_config.h              # set your 2.4 GHz WIFI_SSID / WIFI_PASS
../flash-mac.sh                        # build + flash (auto-detects the port)
```

On boot it joins WiFi, syncs the clock over NTP, fetches the board, and renders
it. It refetches every `FETCH_INTERVAL_MS` (3 min — bounds Google Maps cost) and
redraws every `REFRESH_INTERVAL_MS` (60 s — ticks countdowns locally). The API
URL is `BOARD_API_URL` in `src/config.h`.

## Pinout (this board)

| Signal | GPIO | | Signal | GPIO |
| ------ | ---- |-| ------ | ---- |
| EPD power-enable | **7** | | EPD CS | 45 |
| EPD SCK | 12 | | EPD DC | 46 |
| EPD MOSI (DIN) | 11 | | EPD RST | 47 |
| (no MISO) | −1 | | EPD BUSY | 48 |

**GPIO7 must be driven HIGH before `display.init()`** or the panel gets no
power and stays blank — the #1 gotcha for this board. See `src/display_cfg.h`.

## Architecture

```text
main.cpp        setup()/loop(); powers panel, inits GxEPD2, fetch+render loop,
                serial commands (screenshot / refresh / fetch / settime)
display_cfg.h   pin map + GxEPD2 display type/instance
board_api.{h,cpp}  fetch BOARD_API_URL over HTTPS, parse JSON (ArduinoJson)
board_data.h    parsed shape of /api/departures (boards, leave/depart/arrive)
ui.{h,cpp}      draws the per-station screen into a 1-bit GFXcanvas1
                (the single source of truth for panel + screenshots)
buttons.{h,cpp} up/down toggle (GPIO6/GPIO4) to switch stations
net.{h,cpp}     WiFi association + reconnect
timekeeper.{h,cpp}  NTP sync + America/New_York (TZ EST5EDT,M3.2.0,M11.1.0)
config.h        API URL, fetch/refresh cadence, NTP servers, TZ
wifi_config.h   WiFi creds (gitignored; copy from wifi_config.example.h)

departures.{h,cpp} + schedule_data.h — an on-device port of ../lib/departures.ts
                (validated by ../tools/test). NOT built into the firmware
                anymore (excluded via build_src_filter); kept for the tests and
                as a possible offline fallback if the API is unreachable.
```

## QA without looking at the screen

The firmware renders into a 1-bit canvas and can dump it over serial, so UI
changes can be verified from the host:

```bash
../screenshot.sh out.png                 # capture the current framebuffer → PNG
```

For **design iteration without flashing**, the UI renders natively to a PNG via
a small Arduino shim — edit `src/ui.cpp` and see the result in ~2 s:

```bash
tools/preview/render.sh 1782990900 out.png   # [unix-epoch] [out] [scale] [net] [valid]
```

Serial commands (115200 baud on the CH340 port):

- `screenshot` — dump the framebuffer (used by `screenshot.sh`)
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

## Offline fallback (schedule port + tests)

`../lib/departures.ts` is mirrored by `src/departures.cpp` (kept out of the
firmware build). It's validated against the TS reference over thousands of
timestamps (including the Nov DST boundary):

```bash
bash tools/test/run.sh
```

## Gotchas specific to this board

1. **GPIO7 power-enable HIGH before init** (see above).
2. **SPI must be remapped** — the ESP32-S3 default SPI pins are not the panel
   pins: `SPI.begin(12, -1, 11, 45)` before `display.init()`.
3. **PSRAM = `qio_opi`** (quad flash + octal PSRAM), not `opi_opi`/`qio_qspi`.
4. **Flash over the CH340** (`/dev/cu.usbserial*`, not `usbmodem*`).
   `upload_speed = 460800` is reliable; 921600 is flaky on this bridge.
5. **`ARDUINO_USB_CDC_ON_BOOT=0`** so `Serial` stays on UART0/CH340 — with
   CDC-on-boot you get no serial output and the screenshot dump breaks.
6. E-Ink ghosts under repeated partial refreshes; `FULL_REFRESH_EVERY`
   forces a periodic flashing full refresh to clear it.
