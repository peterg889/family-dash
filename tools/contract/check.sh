#!/bin/bash
# Contract check between the server and the sign.
#
# Runs a saved /api/departures response through the DEVICE'S OWN parser
# (firmware/src/board_parse.cpp, compiled for the laptop) and fails unless it
# yields a usable board: at least one board with at least one train whose
# times are sane, `mode` / `showLeave` / `status.live` read the way they are
# written, and a train still catchable at the response's own `now`. It then
# renders the screen from it, so the result can be looked at.
#
#   tools/contract/check.sh <api.json> [out.png]
#
# CI runs this against tests/fixtures/api-outbound-sample.json — a response
# produced by the server's own code — so the server can't change the shape of
# what the sign reads without this going red. The companion list of every field
# the firmware reads is firmware/api-fields.json.
#   GFX_DIR / ARDUINOJSON_DIR   build without PlatformIO libdeps (see ../preview/_build.sh)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
JSON="${1:?usage: check.sh <api.json> [out.png]}"
OUT="${2:-}"
[ -f "$JSON" ] || { echo "CONTRACT FAIL: no such file: $JSON" >&2; exit 1; }
source "$DIR/../preview/_build.sh"
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

build_preview "$TMP/preview" || { echo "CONTRACT FAIL: host build failed" >&2; exit 1; }
"$TMP/preview" --check "$JSON" "$TMP/screen.raw" || exit 1
if [ -n "$OUT" ]; then
    python3 "$DIR/../preview/raw2png.py" "$TMP/screen.raw" "$OUT" 1 >/dev/null \
        && echo "rendered -> $OUT"
fi
