#!/bin/bash
# Cross-validate the C++ departures port (firmware/src/departures.cpp) against
# the TS reference (ref.mjs, a copy of lib/departures.ts) over many timestamps.
# Exits non-zero on any mismatch.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$DIR/../../firmware/src"
TMP="$(mktemp -d)"
trap "rm -rf '$TMP'" EXIT

echo "Generating test cases..."
node "$DIR/cases.mjs" > "$TMP/cases.txt"
echo "  $(wc -l < "$TMP/cases.txt" | tr -d ' ') timestamps x 4 boards"

echo "Running TS reference..."
node "$DIR/ref.mjs" "$TMP/cases.txt" > "$TMP/ref.txt"

echo "Building + running C++ port..."
c++ -std=c++17 -O2 -I "$SRC" \
    "$DIR/test_departures.cpp" "$SRC/departures.cpp" \
    -o "$TMP/test_departures"
"$TMP/test_departures" "$TMP/cases.txt" > "$TMP/cpp.txt"

echo "Comparing..."
if diff -u "$TMP/ref.txt" "$TMP/cpp.txt" > "$TMP/diff.txt"; then
  echo "PASS — C++ port matches TS reference on all $(wc -l < "$TMP/ref.txt" | tr -d ' ') lines."
else
  echo "FAIL — mismatches:"
  head -40 "$TMP/diff.txt"
  echo "..."
  echo "($(grep -c '^[-+]' "$TMP/diff.txt") diff lines total)"
  exit 1
fi

# Independent anchor correctness (rendered time vs GTFS string, incl. DST).
echo ""
echo "Running DST correctness oracle..."
node "$DIR/dst_check.mjs"
