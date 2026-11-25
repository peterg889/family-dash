# Shared by render.sh / render-all.sh: compile the native preview binary.
# Usage: source _build.sh; build_preview <out-binary>
#
# Adafruit GFX comes from the firmware's PlatformIO libdeps by default; point
# GFX_DIR at a checkout of Adafruit-GFX-Library to build without PlatformIO
# (this is what CI does).
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

build_preview() {
    if [ ! -f "$GFX_DIR/Adafruit_GFX.cpp" ]; then
        echo "Adafruit GFX not found at: $GFX_DIR" >&2
        echo "Build the firmware once (pio run -d firmware) or set GFX_DIR." >&2
        return 1
    fi
    "${CXX:-c++}" -std=c++17 -O1 -w -DARDUINO=10819 \
        -I "$PREVIEW_DIR/shim" -I "$GFX_DIR" -I "$PREVIEW_SRC" \
        "$PREVIEW_DIR/preview_main.cpp" "$PREVIEW_SRC/ui.cpp" \
        "$GFX_DIR/Adafruit_GFX.cpp" \
        -o "$1"
}
