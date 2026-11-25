#!/bin/bash
# Build the Family Dashboard firmware and upload it over WiFi (no USB cable).
#
# Needs a board that is already running an OTA-enabled build (flash once over
# USB with ./flash-mac.sh) and OTA_PASSWORD defined in firmware/src/wifi_config.h.
# The laptop must be on the same network as the board.
#
# Usage:
#   ./flash-ota.sh                      # uploads to family-dash-eink.local
#   ./flash-ota.sh 192.168.1.57         # or address the board by IP
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${1:-family-dash-eink.local}"
CFG="$SCRIPT_DIR/firmware/src/wifi_config.h"

if [ ! -f "$CFG" ]; then
    echo "Error: firmware/src/wifi_config.h missing (see wifi_config.example.h)."
    exit 1
fi

# Read the OTA password out of the gitignored config. It is never printed.
OTA_PW="$(sed -n 's/^[[:space:]]*#define[[:space:]][[:space:]]*OTA_PASSWORD[[:space:]][[:space:]]*"\(.*\)".*$/\1/p' "$CFG" | tail -1)"
if [ -z "$OTA_PW" ]; then
    echo "Error: OTA_PASSWORD is not defined in firmware/src/wifi_config.h."
    echo "  Add:  #define OTA_PASSWORD \"<long random string>\"   (openssl rand -hex 12)"
    echo "  then flash once over USB (./flash-mac.sh) so the board starts listening."
    exit 1
fi

PIO="$(command -v pio || echo "$HOME/.platformio/penv/bin/pio")"
if [ ! -x "$PIO" ] && ! command -v pio >/dev/null; then
    echo "Error: 'pio' not found. Install PlatformIO (brew install platformio)."
    exit 1
fi

# espota.py ships with the Arduino core, so it always matches the OTA protocol
# of the firmware being built.
ESPOTA="$HOME/.platformio/packages/framework-arduinoespressif32/tools/espota.py"
PIO_PY="$HOME/.platformio/penv/bin/python"
[ -x "$PIO_PY" ] || PIO_PY=python3
BIN="$SCRIPT_DIR/firmware/.pio/build/crowpanel_epaper42/firmware.bin"

echo "=== Building ==="
"$PIO" run -d "$SCRIPT_DIR/firmware"
if [ ! -f "$ESPOTA" ] || [ ! -f "$BIN" ]; then
    echo "Error: build did not produce firmware.bin, or espota.py is missing."
    exit 1
fi

echo ""
echo "=== Flashing Family Dashboard over WiFi ==="
echo "Board: $HOST"
echo ""
"$PIO_PY" "$ESPOTA" --ip "$HOST" --port 3232 --auth "$OTA_PW" \
    --file "$BIN" --progress

echo ""
echo "=== Done — the board reboots into the new firmware ==="
echo "If the upload could not connect: check the board is on WiFi, try its IP"
echo "instead of the .local name, and allow incoming connections for python in"
echo "the macOS firewall (the board connects back to this laptop to fetch the image)."
