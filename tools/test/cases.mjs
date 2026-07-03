#!/usr/bin/env node
// Emit a deterministic list of unix-second timestamps (one per line) used to
// cross-validate the C++ departures port against the TS reference. Covers the
// whole active schedule window plus fine sweeps over the Nov 1 2026 DST-end
// boundary and a summer after-midnight window.
const out = new Set();

// Coarse sweep across the active range, 30.5-min step (varies minute-of-hour).
const start = Math.floor(Date.UTC(2026, 6, 2, 8, 0, 0) / 1000); // ~Jul 2 04:00 ET
const end = Math.floor(Date.UTC(2026, 10, 8, 23, 0, 0) / 1000); // ~Nov 8 ET
for (let t = start; t <= end; t += 1830) out.add(t);

// Fine sweep over DST end (Nov 1 2026 02:00 ET) + the after-midnight window.
const dstStart = Math.floor(Date.UTC(2026, 10, 1, 0, 0, 0) / 1000);
const dstEnd = Math.floor(Date.UTC(2026, 10, 1, 13, 0, 0) / 1000);
for (let t = dstStart; t <= dstEnd; t += 300) out.add(t);

// Fine sweep over a summer midnight (Jul 5->6), exercises the -1 day window.
const sumStart = Math.floor(Date.UTC(2026, 6, 6, 0, 0, 0) / 1000);
const sumEnd = Math.floor(Date.UTC(2026, 6, 6, 12, 0, 0) / 1000);
for (let t = sumStart; t <= sumEnd; t += 300) out.add(t);

const list = [...out].sort((a, b) => a - b);
process.stdout.write(list.join("\n") + "\n");
