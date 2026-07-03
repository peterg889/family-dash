#!/bin/bash
# Render the E-Ink UI natively (no device) to a PNG for fast design iteration.
# Usage: tools/preview/render.sh [unix-epoch] [out.png] [scale] [net] [valid]
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$DIR/../.."
SRC="$ROOT/firmware/src"
LIB="$ROOT/firmware/.pio/libdeps/crowpanel_epaper42/Adafruit GFX Library"
SHIM="$DIR/shim"
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

EPOCH="${1:-$(date +%s)}"
OUT="${2:-$DIR/preview.png}"
SCALE="${3:-2}"
SCREEN="${4:-0}"  # 0 = leave, 1 = board

c++ -std=c++17 -O1 -w -DARDUINO=10819 \
    -I "$SHIM" -I "$LIB" -I "$SRC" \
    "$DIR/preview_main.cpp" "$SRC/ui.cpp" \
    "$LIB/Adafruit_GFX.cpp" \
    -o "$TMP/preview"

"$TMP/preview" "$EPOCH" "$TMP/preview.raw" "$SCREEN"

python3 "$DIR/raw2png.py" "$TMP/preview.raw" "$OUT" "$SCALE"
echo "-> $OUT"
