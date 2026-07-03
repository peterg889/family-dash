#!/usr/bin/env node
// Independent correctness oracle for the departure-time anchor.
//
// run.sh only proves the C++ port matches the TS reference — a shared anchor
// bug still agrees. This instead compares the RENDERED local clock time to the
// GTFS schedule string itself (ground truth), on ordinary days AND across the
// Nov 1 2026 daylight-saving fall-back, where a local-midnight anchor renders
// every time 1 hour early.
import { nextDepartures, nyLocalEpoch, schedule } from "./ref.mjs";

const TZ = "America/New_York";
const BOARDS = [
  { origin: "92", dest: "105" },
  { origin: "92", dest: "63" },
  { origin: "18", dest: "105" },
  { origin: "18", dest: "63" },
];
const DATES = ["20261101", "20261020", "20260706", "20260704"]; // DST day + ordinary
const NAME = { ...schedule.origins, ...schedule.destinations };

const timeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ, hour: "numeric", minute: "2-digit",
});
const dateFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
});
const localTime = (ms) => timeFmt.format(new Date(ms));
const localDate = (ms) => dateFmt.format(new Date(ms)).replaceAll("-", "");

// Expected local clock time for a GTFS "HH:MM:SS" (handles 24:xx/25:xx wrap).
function expectedLocal(gtfs) {
  let [h, m] = gtfs.split(":").map(Number);
  h %= 24;
  const ap = h < 12 ? "AM" : "PM";
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, "0")} ${ap}`;
}
const gsec = (t) => { const [h, m, s] = t.split(":").map(Number); return h * 3600 + m * 60 + s; };
const prevDate = (date) => {
  const y = +date.slice(0, 4), mo = +date.slice(4, 6), d = +date.slice(6, 8);
  const p = new Date(Date.UTC(y, mo - 1, d - 1));
  return `${p.getUTCFullYear()}${String(p.getUTCMonth() + 1).padStart(2, "0")}${String(p.getUTCDate()).padStart(2, "0")}`;
};

let failures = 0, checks = 0;
for (const date of DATES) {
  const y = +date.slice(0, 4), mo = +date.slice(4, 6), d = +date.slice(6, 8);
  const startOfDay = nyLocalEpoch(y, mo, d, 0);
  const prev = prevDate(date);

  for (const b of BOARDS) {
    const runs = (t, dt) =>
      t.origin === b.origin && t.dest === b.dest &&
      schedule.calendar[t.service]?.includes(dt);

    // Ground truth for what lands on calendar-date `date`: this day's trips
    // before midnight, plus the previous service day's after-midnight (24:xx).
    const expected = [
      ...schedule.trips.filter((t) => runs(t, date) && gsec(t.dep) < 86400),
      ...schedule.trips.filter((t) => runs(t, prev) && gsec(t.dep) >= 86400),
    ].map((t) => expectedLocal(t.dep)).sort();

    const got = nextDepartures(b.origin, b.dest, startOfDay, 100)
      .filter((x) => localDate(x.depEpochMs) === date)
      .map((x) => localTime(x.depEpochMs))
      .sort();

    checks++;
    const eq = expected.length === got.length && expected.every((v, i) => v === got[i]);
    if (!eq) {
      failures++;
      console.log(`FAIL ${date} ${NAME[b.origin]}->${NAME[b.dest]}`);
      console.log(`  expected: [${expected.join(", ")}]`);
      console.log(`  got:      [${got.join(", ")}]`);
    }
  }
}

// Explicit pinpoint: on the fall-back day, the first Morristown->NY after 3am
// local must be the 5:23 train, rendered 5:23 AM (not 4:23 under the old bug).
const nov1_3am = nyLocalEpoch(2026, 11, 1, 3);
const first = nextDepartures("92", "105", nov1_3am, 1)[0];
const firstTime = first ? localTime(first.depEpochMs) : "(none)";
if (firstTime !== "5:23 AM") {
  failures++;
  console.log(`FAIL pinpoint: Nov 1 first Morristown->NY after 3am = ${firstTime}, expected 5:23 AM`);
}
checks++;

if (failures) {
  console.log(`\nDST-CHECK FAIL — ${failures}/${checks} checks mismatch.`);
  process.exit(1);
} else {
  console.log(`DST-CHECK PASS — rendered times match the GTFS schedule on all ${checks} checks (incl. Nov 1 2026 fall-back).`);
}
