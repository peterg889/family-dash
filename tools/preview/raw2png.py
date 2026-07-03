#!/usr/bin/env python3
# Convert a 1-bit 400x300 framebuffer dump (MSB-first, 1=ink) to a PNG,
# optionally upscaled. Stdlib only.
import sys, zlib, struct, binascii

raw_path, out_path = sys.argv[1], sys.argv[2]
scale = int(sys.argv[3]) if len(sys.argv) > 3 else 1
w, h = 400, 300
data = open(raw_path, "rb").read()
stride = (w + 7) // 8

def ink(x, y):
    return (data[y * stride + (x >> 3)] >> (7 - (x & 7))) & 1

W, H = w * scale, h * scale
rows = []
for y in range(H):
    sy = y // scale
    row = bytearray(W)
    for x in range(W):
        row[x] = 0 if ink(x // scale, sy) else 255
    rows.append(bytes(row))

def ch(t, p):
    b = t + p
    return struct.pack(">I", len(p)) + b + struct.pack(">I", binascii.crc32(b) & 0xffffffff)

raw = b"".join(b"\x00" + r for r in rows)
png = b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 0, 0, 0, 0))
png += ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b"")
open(out_path, "wb").write(png)
print(f"{out_path} ({W}x{H})")
