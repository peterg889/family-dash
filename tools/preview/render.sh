#!/bin/bash
# Render the E-Ink screen natively (no device) to a PNG for fast design iteration.
#
#   tools/preview/render.sh [unix-epoch|0] [out.png] [scale] [page] [scenario]
#       epoch     0 = the scenario's own time of day
#       page      which page of later trains ("" = the scenario's own)
#       scenario  morning (default), tomorrow, cancelled-first, alert,
#                 offline-banner, ... — `render.sh --list` for all
#
#   tools/preview/render.sh --json <api.json> [out.png] [unix-epoch|0] [scale] [page]
#       Render a REAL /api/departures response through the device's own parser.
#       epoch 0 = the response's own `now`. e.g.
#         curl -s 'https://family-dash-beta.vercel.app/api/departures?direction=outbound&limit=12' > /tmp/api.json
#         tools/preview/render.sh --json /tmp/api.json /tmp/now.png
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
source "$DIR/_build.sh"
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

build_preview "$TMP/preview"
if [ "$1" = "--list" ]; then
    "$TMP/preview" --list
    exit 0
fi

if [ "$1" = "--json" ]; then
    JSON="${2:?usage: render.sh --json <api.json> [out.png] [epoch] [scale] [page]}"
    OUT="${3:-$DIR/preview.png}"
    EPOCH="${4:-0}"
    SCALE="${5:-2}"
    PAGE="${6:-0}"
    "$TMP/preview" --json "$JSON" "$TMP/preview.raw" "$EPOCH" "$PAGE"
else
    EPOCH="${1:-0}"
    OUT="${2:-$DIR/preview.png}"
    SCALE="${3:-2}"
    PAGE="${4:-}"
    SCENARIO="${5:-}"
    "$TMP/preview" "$EPOCH" "$TMP/preview.raw" "$PAGE" "$SCENARIO"
fi
python3 "$DIR/raw2png.py" "$TMP/preview.raw" "$OUT" "$SCALE"
echo "-> $OUT"
