#!/bin/bash
# Build and flash the Family Dashboard firmware onto the CrowPanel 4.2" E-Paper.
# Usage:
#   ./flash-mac.sh                    # auto-detect /dev/cu.usbserial*
#   ./flash-mac.sh /dev/cu.usbserial-10
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PORT="$1"

if [ -z "$PORT" ]; then
    # CrowPanel uses a CH340 bridge → /dev/cu.usbserial* (not usbmodem).
    PORT=$(ls /dev/cu.usbserial* 2>/dev/null | head -1)
    if [ -z "$PORT" ]; then
        echo "Error: no /dev/cu.usbserial* device found. Plug the board in via USB."
        exit 1
    fi
fi

PIO="$(command -v pio || echo "$HOME/.platformio/penv/bin/pio")"
if [ ! -x "$PIO" ] && ! command -v pio >/dev/null; then
    echo "Error: 'pio' not found. Install PlatformIO (brew install platformio)."
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/firmware/src/wifi_config.h" ]; then
    echo "Error: firmware/src/wifi_config.h missing."
    echo "  cp firmware/src/wifi_config.example.h firmware/src/wifi_config.h"
    echo "  \$EDITOR firmware/src/wifi_config.h   # set WIFI_SSID / WIFI_PASS"
    exit 1
fi

echo "=== Flashing Family Dashboard ==="
echo "Port: $PORT"
echo ""

"$PIO" run -d "$SCRIPT_DIR/firmware" -t upload --upload-port "$PORT"

echo ""
echo "=== Done ==="
echo "Monitor: pio device monitor -p $PORT -b 115200"
echo "Screenshot: ./screenshot.sh out.png $PORT"
