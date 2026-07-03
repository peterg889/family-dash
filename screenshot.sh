#!/bin/bash
# Capture the E-Paper framebuffer over serial and save it as a PNG.
# The firmware renders into a 1-bit canvas and dumps it on the "screenshot"
# serial command; this expands it to an 8-bit grayscale PNG (no ffmpeg/PIL).
# Usage: ./screenshot.sh [out.png] [port]
OUTPUT="${1:-screenshot.png}"
PORT="${2:-$(ls /dev/cu.usbserial* 2>/dev/null | head -1)}"

if [ -z "$PORT" ]; then
    echo "No serial port found (pass one explicitly)." >&2
    exit 1
fi

PIO_PY="$HOME/.platformio/penv/bin/python"
[ -x "$PIO_PY" ] || PIO_PY=python3

"$PIO_PY" - "$PORT" "$OUTPUT" << 'PYEOF'
import serial, sys, zlib, struct, binascii

port_path, out_path = sys.argv[1], sys.argv[2]
port = serial.Serial(port_path, 115200, timeout=15)
port.reset_input_buffer()
port.write(b"screenshot\n")
port.flush()

w = h = size = None
for _ in range(200):
    line = port.readline().decode("utf-8", "replace").strip()
    if line.startswith("SCREENSHOT_START"):
        _, ws, hs, ss = line.split()
        w, h, size = int(ws), int(hs), int(ss)
        break
if size is None:
    print("Did not see SCREENSHOT_START", file=sys.stderr)
    sys.exit(1)

data = b""
while len(data) < size:
    chunk = port.read(size - len(data))
    if not chunk:
        print(f"Timeout: {len(data)}/{size} bytes", file=sys.stderr)
        sys.exit(1)
    data += chunk
port.close()

# 1bpp, MSB-first, bit==1 is ink (black). Expand to 8-bit grayscale.
stride = (w + 7) // 8
rows = []
for y in range(h):
    row = bytearray(w)
    base = y * stride
    for x in range(w):
        bit = (data[base + (x >> 3)] >> (7 - (x & 7))) & 1
        row[x] = 0 if bit else 255
    rows.append(bytes(row))

def png_chunk(typ, payload):
    body = typ + payload
    return struct.pack(">I", len(payload)) + body + \
        struct.pack(">I", binascii.crc32(body) & 0xffffffff)

raw = b"".join(b"\x00" + r for r in rows)  # filter byte 0 per scanline
png = b"\x89PNG\r\n\x1a\n"
png += png_chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
png += png_chunk(b"IDAT", zlib.compress(raw, 9))
png += png_chunk(b"IEND", b"")
open(out_path, "wb").write(png)
print(f"Saved {out_path} ({w}x{h})")
PYEOF
