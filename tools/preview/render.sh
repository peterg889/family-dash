#!/bin/bash
# Render one E-Ink screen natively (no device) to a PNG for fast design iteration.
# Usage: tools/preview/render.sh [unix-epoch|0] [out.png] [scale] [screen] [scenario]
#   epoch     0 = the scenario's own time of day
#   screen    0 = Morristown, 1 = Bernardsville
#   scenario  morning (default), evening, next-morning, cancelled-first,
#             offline-banner, schedule-expired, ... — `render.sh --list` for all
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

EPOCH="${1:-0}"
OUT="${2:-$DIR/preview.png}"
SCALE="${3:-2}"
SCREEN="${4:-0}"
SCENARIO="${5:-}"

"$TMP/preview" "$EPOCH" "$TMP/preview.raw" "$SCREEN" "$SCENARIO"
python3 "$DIR/raw2png.py" "$TMP/preview.raw" "$OUT" "$SCALE"
echo "-> $OUT"
