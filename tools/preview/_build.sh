# Shared by render.sh / render-all.sh / ../contract/check.sh: compile the native
# preview binary.   Usage: source _build.sh; build_preview <out-binary>
#
# It is built from the firmware's own sources — ui.cpp (the screen) and
# board_parse.cpp (the JSON parser) — so what it draws and what it accepts are
# exactly what the device does.
#
# Libraries come from the firmware's PlatformIO libdeps by default (run
# `pio run -d firmware` once). To build without PlatformIO, point
#   GFX_DIR          at a checkout of Adafruit-GFX-Library (1.x layout)
#   ARDUINOJSON_DIR  at ArduinoJson's `src` directory
PREVIEW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PREVIEW_ROOT="$PREVIEW_DIR/../.."
PREVIEW_SRC="$PREVIEW_ROOT/firmware/src"
PREVIEW_LIBDEPS="$PREVIEW_ROOT/firmware/.pio/libdeps/crowpanel_epaper42"

# PlatformIO can hold two copies of Adafruit GFX: the version pinned in
# platformio.ini (in "Adafruit GFX Library@<version>") and whatever GxEPD2's own
# unpinned dependency pulled in (in "Adafruit GFX Library"). Use the pinned one —
# the one the firmware is actually built with — and fall back to any copy that
# has the sources.
find_gfx() {
    local d
    for d in "$PREVIEW_LIBDEPS"/Adafruit\ GFX\ Library@* "$PREVIEW_LIBDEPS/Adafruit GFX Library"; do
        [ -f "$d/Adafruit_GFX.cpp" ] && { echo "$d"; return; }
        [ -f "$d/src/Adafruit_GFX.cpp" ] && { echo "$d/src"; return; }
    done
    echo "$PREVIEW_LIBDEPS/Adafruit GFX Library"
}
GFX_DIR="${GFX_DIR:-$(find_gfx)}"
ARDUINOJSON_DIR="${ARDUINOJSON_DIR:-$PREVIEW_LIBDEPS/ArduinoJson/src}"

build_preview() {
    if [ ! -f "$GFX_DIR/Adafruit_GFX.cpp" ]; then
        echo "Adafruit GFX not found at: $GFX_DIR" >&2
        echo "Build the firmware once (pio run -d firmware) or set GFX_DIR." >&2
        return 1
    fi
    if [ ! -f "$ARDUINOJSON_DIR/ArduinoJson.h" ]; then
        echo "ArduinoJson not found at: $ARDUINOJSON_DIR" >&2
        echo "Build the firmware once (pio run -d firmware) or set ARDUINOJSON_DIR." >&2
        return 1
    fi
    local obj
    obj="$(mktemp -d)" || return 1
    # The parser is compiled as plain C++ — no Arduino shim, no -DARDUINO — which
    # is the whole point of keeping it Arduino-free: ArduinoJson then builds in
    # its standard-library mode.
    "${CXX:-c++}" -std=c++17 -O1 -w \
        -I "$ARDUINOJSON_DIR" -I "$PREVIEW_SRC" \
        -c "$PREVIEW_SRC/board_parse.cpp" -o "$obj/board_parse.o" || { rm -rf "$obj"; return 1; }
    "${CXX:-c++}" -std=c++17 -O1 -w -DARDUINO=10819 \
        -I "$PREVIEW_DIR/shim" -I "$GFX_DIR" -I "$PREVIEW_SRC" \
        "$PREVIEW_DIR/preview_main.cpp" "$PREVIEW_SRC/ui.cpp" \
        "$GFX_DIR/Adafruit_GFX.cpp" "$obj/board_parse.o" \
        -o "$1"
    local rc=$?
    rm -rf "$obj"
    return $rc
}
