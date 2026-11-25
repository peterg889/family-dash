#!/usr/bin/env node
/**
 * Looks at the live dashboard the way a person would and reports anything that
 * needs attention: the server not answering, an expiring timetable, NJ Transit
 * live status gone, no drive times, no trains, or the E-Ink sign gone quiet.
 *
 * Usage:
 *   node scripts/health-check.mjs            # prints problems; exit 1 if any
 *   HEALTH_URL=... SIGN_MAX_QUIET_MIN=45 CHECK_SIGN=0 node scripts/health-check.mjs
 *
 * .github/workflows/health.yml runs it hourly and opens (or closes) a GitHub
 * issue, so the owner hears about a problem once rather than every hour.
 */

const DEFAULT_URL = "https://family-dash-beta.vercel.app/api/departures?direction=outbound";

const fmtNy = (ms) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(ms);

/**
 * Pure check of one API response. Returns a list of plain-language problems
 * (empty = healthy). `opts.checkSign` false skips the sign check.
 */
export function evaluate(body, nowMs, opts = {}) {
  const signMaxQuietMin = opts.signMaxQuietMin ?? 45;
  const checkSign = opts.checkSign ?? true;
  const problems = [];
  const st = body?.status;
  if (!st || !Array.isArray(body?.boards)) {
    return ["The dashboard answered, but not with a train board."];
  }

  if (st.schedule?.expired) {
    problems.push("The timetable has expired — no trains can be shown until it is refreshed.");
  } else if (typeof st.schedule?.daysLeft === "number" && st.schedule.daysLeft < 7) {
    problems.push(
      `The timetable runs out in ${st.schedule.daysLeft} day(s) and the daily refresh hasn't replaced it.`
    );
  }

  if (st.live === "down") {
    problems.push("NJ Transit live status is unavailable — the board is showing the timetable only.");
  }

  if (body.showLeave && st.drive === "none") {
    problems.push("There are no drive times — Google isn't answering, so there is no “leave by”.");
  }
  const measured = body.boards
    .map((b) => b.driveMeasuredAtMs)
    .filter((t) => typeof t === "number");
  if (measured.length > 0) {
    const newest = Math.max(...measured);
    if (nowMs - newest > 30 * 3600_000) {
      problems.push(`Drive times haven't been measured since ${fmtNy(newest)}.`);
    }
  }

  if (!st.schedule?.expired && body.boards.every((b) => (b.departures ?? []).length === 0)) {
    problems.push("Every board is empty — no trains are being shown.");
  }

  if (checkSign) {
    const seen = st.device?.lastSeenMs;
    if (typeof seen === "number" && nowMs - seen > signMaxQuietMin * 60_000) {
      problems.push(
        `The E-Ink sign hasn't checked in since ${fmtNy(seen)} — it may be unplugged or off WiFi.`
      );
    }
    // Never seen at all is not an alarm: the sign may predate check-ins.
  }
  return problems;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchBoard(url) {
  const res = await fetch(url, {
    headers: { "Cache-Control": "no-cache" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main() {
  const url = process.env.HEALTH_URL ?? DEFAULT_URL;
  const opts = {
    signMaxQuietMin: Number(process.env.SIGN_MAX_QUIET_MIN ?? 45),
    checkSign: process.env.CHECK_SIGN !== "0",
  };

  // A single blip isn't news: anything wrong must still be wrong 90 s later.
  let problems = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await wait(90_000);
    try {
      problems = evaluate(await fetchBoard(url), Date.now(), opts);
    } catch (e) {
      problems = [`The dashboard isn't answering (${e instanceof Error ? e.message : "error"}).`];
    }
    if (problems.length === 0) break;
  }

  if (problems.length === 0) {
    console.log("Healthy.");
    return;
  }
  for (const p of problems) console.log(`- ${p}`);
  process.exitCode = 1;
}

// Run only when executed directly (tests import `evaluate`).
if (import.meta.url === `file://${process.argv[1]}`) await main();
