#!/bin/bash
# Render every preview scenario for both stations into <outdir> as PNGs.
# Exits non-zero if the preview fails to build or any scenario fails to render,
# so CI can run it as a smoke test of ui.cpp (including every failure state).
# Usage: tools/preview/render-all.sh <outdir> [scale]
#   GFX_DIR=/path/to/Adafruit-GFX-Library   build without PlatformIO libdeps
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_build.sh"
OUT="${1:?usage: render-all.sh <outdir> [scale]}"
SCALE="${2:-1}"
mkdir -p "$OUT" || exit 1
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

build_preview "$TMP/preview" || { echo "FAIL: preview did not build" >&2; exit 1; }

EXPECTED=$((400 / 8 * 300))
fail=0
count=0
while read -r scenario; do
    for screen in 0 1; do
        name=$([ "$screen" = 0 ] && echo morristown || echo bernardsville)
        raw="$TMP/$scenario-$name.raw"
        png="$OUT/$scenario-$name.png"
        if "$TMP/preview" 0 "$raw" "$screen" "$scenario" 2>"$TMP/err" \
            && [ "$(wc -c <"$raw" | tr -d ' ')" = "$EXPECTED" ] \
            && python3 "$DIR/raw2png.py" "$raw" "$png" "$SCALE" >/dev/null; then
            count=$((count + 1))
        else
            echo "FAIL: $scenario ($name)" >&2
            cat "$TMP/err" >&2
            fail=1
        fi
    done
done < <("$TMP/preview" --list)

if [ "$count" = 0 ]; then
    echo "FAIL: no scenarios rendered" >&2
    exit 1
fi
echo "rendered $count screens -> $OUT"
exit $fail
