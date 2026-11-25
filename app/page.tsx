"use client";

import { useEffect, useState, type ReactElement } from "react";

type LiveStatus = {
  state: "on-time" | "delayed" | "cancelled" | "boarding" | "unknown";
  delayMin: number;
  statusText: string;
  track: string | null;
  trainId: string | null;
};

type Departure = {
  depEpochMs: number;
  arrEpochMs: number;
  depTime: string;
  arrTime: string;
  routeName: string;
  routeShort: string;
  color: string;
  headsign: string;
  durationMin: number;
  leaveByEpochMs: number | null;
  live?: LiveStatus | null;
};

// "live": measured by Google in the last few minutes. "earlier": Google's most
// recent measurement (outside the morning hours it isn't re-measured).
type DriveSource = "live" | "earlier" | null;

type Board = {
  origin: string;
  dest: string;
  destShort?: string;
  driveMin: number | null;
  driveSource?: DriveSource;
  driveMeasuredAtMs?: number | null;
  departures: Departure[];
};

type Commute = {
  name: string;
  driveMin: number | null;
  driveSource?: DriveSource;
  driveMeasuredAtMs?: number | null;
  etaEpochMs: number | null;
};

// What each data source is doing — so the page can say what's wrong instead of
// showing a plausible-looking empty board.
type Status = {
  schedule: {
    validThrough: string | null;
    daysLeft: number;
    expired: boolean;
  };
  live: "ok" | "down" | "off";
  drive: "live" | "earlier" | "none" | "off";
};

type Direction = "outbound" | "inbound";

type ApiResponse = {
  now: number;
  generatedAt: string;
  headline?: string;
  direction?: Direction;
  showLeave?: boolean;
  status?: Status;
  alerts?: { text: string; urgent?: boolean }[];
  commute?: Commute | null;
  boards: Board[];
};

/** "16" for a just-measured drive time, "~16" for an earlier measurement. */
function driveLabel(min: number, source?: DriveSource): string {
  return source === "earlier" ? `~${min}` : `${min}`;
}

/** Tooltip saying when Google measured this drive time. */
function driveTitle(source?: DriveSource, measuredAtMs?: number | null): string {
  if (!measuredAtMs) return "";
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(measuredAtMs);
  return source === "earlier"
    ? `Google traffic, measured ${when} (re-measured each morning)`
    : `Google traffic, measured ${when}`;
}

/** One-line notices about degraded data, most serious first. */
function notices(data: ApiResponse, stale: boolean, error: boolean): string[] {
  const out: string[] = [];
  const st = data.status;
  if (st?.schedule.expired) {
    out.push(
      "Timetable out of date — the schedule on the server has expired, so trains can’t be shown."
    );
  } else if (st && st.schedule.daysLeft <= 7) {
    out.push(
      `Timetable runs out in ${Math.max(0, st.schedule.daysLeft)} day${st.schedule.daysLeft === 1 ? "" : "s"} — it needs refreshing.`
    );
  }
  if (error || stale) out.push("Can’t reach the server — showing the last board received.");
  if (st?.live === "down") out.push("NJ Transit live status unavailable — showing the timetable only.");
  if (st?.drive === "none")
    out.push("No drive time — Google traffic isn’t answering. Showing train times only.");
  return out;
}

const REFRESH_MS = 30_000;

// Compare departures against "today" in New York so a train rolling into
// tomorrow gets a clear day tag instead of an unexplained 20-hour countdown.
const NY_YMD = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const NY_WD = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
});
const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

/** "10:42 PM" -> { hm: "10:42", ap: "p" } — meridiem squeezed to one letter. */
function splitTime(t: string): { hm: string; ap: string } {
  const m = t.match(/^(\d{1,2}:\d{2})\s*([AP]M)?$/i);
  if (!m) return { hm: t, ap: "" };
  return { hm: m[1], ap: (m[2]?.[0] ?? "").toLowerCase() };
}

function countdownLabel(mins: number): string {
  if (mins <= 0) return "NOW";
  if (mins < 60) return `${mins}`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

/** A clock time as "9:56" + small "a"/"p", with optional weekday prefix. */
function Clock({ epoch, withDay, now }: { epoch: number; withDay?: boolean; now?: number }) {
  const { hm, ap } = splitTime(NY_CLOCK.format(epoch));
  const showDay =
    withDay && now != null && NY_YMD.format(epoch) !== NY_YMD.format(now);
  return (
    <>
      {showDay && <span className="day">{NY_WD.format(epoch)}</span>}
      {hm}
      <span className="ap">{ap}</span>
    </>
  );
}

/** Live delay / track / status from DepartureVision, when we have a match. */
function LiveBadge({ live }: { live: LiveStatus }) {
  const track =
    live.track && live.state !== "cancelled" ? (
      <span className="trk">Trk {live.track}</span>
    ) : null;

  // Only flag exceptions — an on-time train just shows its track, so real
  // problems stand out on a glanceable board.
  let label: ReactElement | null = null;
  if (live.state === "cancelled")
    label = <span className="lv cancelled">cancelled</span>;
  else if (live.state === "boarding")
    label = <span className="lv boarding">all aboard</span>;
  else if (live.state === "delayed")
    label = <span className="lv late">+{live.delayMin} late</span>;

  if (!label && !track) return null;
  return (
    <span className="live">
      {label}
      {track}
    </span>
  );
}

/**
 * One route as a table row-group: a route header row, then a row per
 * upcoming train with (leave) / depart / arrive going across — so the same
 * columns line up across every route and you can scan down to compare. The
 * "leave" column only appears for outbound trips (you drive from home).
 */
function BoardGroup({
  board,
  now,
  showLeave,
}: {
  board: Board;
  now: number;
  showLeave: boolean;
}) {
  const trains = board.departures;
  const lead = trains[0];
  const rail = lead ? `#${lead.color}` : "var(--rule)";
  const span = showLeave ? 4 : 3;

  return (
    <tbody className="group">
      <tr className="route-row">
        <td colSpan={span}>
          <span className="rail" style={{ background: rail }} />
          <span className="from">{board.origin}</span>
          <span className="arr-i">→</span>
          <span className="to">{board.destShort ?? board.dest}</span>
          {board.driveMin != null && (
            <span
              className="drive"
              title={driveTitle(board.driveSource, board.driveMeasuredAtMs)}
            >
              {driveLabel(board.driveMin, board.driveSource)} min drive
            </span>
          )}
        </td>
      </tr>

      {trains.length === 0 ? (
        <tr>
          <td className="none" colSpan={span}>
            no more direct trains
          </td>
        </tr>
      ) : (
        trains.map((d) => {
          const mins = Math.round((d.depEpochMs - now) / 60000);
          const cdCls = mins <= 0 ? "now" : mins < 6 ? "soon" : "";
          const late = d.leaveByEpochMs != null && d.leaveByEpochMs <= now;
          const soon =
            d.leaveByEpochMs != null &&
            !late &&
            d.leaveByEpochMs - now < 10 * 60_000;
          return (
            <tr className="train-row" key={d.depEpochMs + d.headsign}>
              <td className={`cd ${cdCls}`}>
                {mins <= 0 ? "NOW" : `in ${countdownLabel(mins)}${mins < 60 ? "m" : ""}`}
              </td>
              {showLeave && (
                <td className={`v leave ${late ? "late" : soon ? "soon" : ""}`}>
                  {d.leaveByEpochMs != null ? <Clock epoch={d.leaveByEpochMs} /> : "—"}
                </td>
              )}
              <td className="v">
                <Clock epoch={d.depEpochMs} withDay now={now} />
                {d.live && <LiveBadge live={d.live} />}
              </td>
              <td className="v">
                <Clock epoch={d.arrEpochMs} />
              </td>
            </tr>
          );
        })
      )}
    </tbody>
  );
}

export default function Page() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState(false);
  // Which way to look. "auto" lets the server pick by time of day (to the city
  // in the morning, home in the evening); tapping a direction pins it until
  // the page is reloaded.
  const [want, setWant] = useState<Direction | "auto">("auto");

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch(
          want === "auto" ? "/api/departures" : `/api/departures?direction=${want}`,
          { cache: "no-store" }
        );
        if (!res.ok) throw new Error("bad response");
        const json: ApiResponse = await res.json();
        if (active) {
          setData(json);
          setFetchedAt(Date.now());
          setError(false);
        }
      } catch {
        if (active) setError(true);
      }
    }
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [want]);

  const clockTime = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
  }).format(now);

  const stale = fetchedAt > 0 && now - fetchedAt > REFRESH_MS * 2;
  const live = !error && !stale;

  return (
    <main className="panel-wrap">
      <section className="panel">
        <div className="topbar">
          <span className="kicker">
            <span className={`pulse ${live ? "on" : "off"}`} />
            NJ TRANSIT{data?.headline ? ` · ${data.headline}` : ""}
          </span>
          <span className="clock">{clockTime}</span>
        </div>

        <div className="direction" role="group" aria-label="Direction">
          {(
            [
              ["outbound", "To the city"],
              ["inbound", "Heading home"],
            ] as [Direction, string][]
          ).map(([dir, label]) => (
            <button
              key={dir}
              type="button"
              className={data?.direction === dir ? "on" : ""}
              aria-pressed={data?.direction === dir}
              onClick={() => setWant(dir)}
            >
              {label}
            </button>
          ))}
        </div>

        {data?.alerts?.map((a) => (
          <div className="alert" key={a.text}>
            <span className="alert-tag">NJ Transit</span> {a.text}
          </div>
        ))}

        {data &&
          notices(data, stale, error).map((n) => (
            <div className="notice" key={n}>
              {n}
            </div>
          ))}

        {data ? (
          <table className="board-table">
            <thead>
              <tr>
                <th />
                {data.showLeave !== false && <th>leave</th>}
                <th>depart</th>
                <th>arrive</th>
              </tr>
            </thead>
            {data.boards.map((b) => (
              <BoardGroup
                key={b.origin + b.dest}
                board={b}
                now={now}
                showLeave={data.showLeave !== false}
              />
            ))}
          </table>
        ) : (
          <div className="loading">
            {error ? "Couldn’t load schedule." : "Loading…"}
          </div>
        )}
      </section>

      {data?.commute?.driveMin != null && (
        <div className="panel commute">
          <span className="cm-left">
            <span className="cm-kicker">drive time</span>
            <span className="cm-name">{data.commute.name}</span>
          </span>
          <span className="cm-right">
            <span className="cm-time">
              {driveLabel(data.commute.driveMin, data.commute.driveSource)}
              <span className="cm-unit">min</span>
            </span>
            {data.commute.etaEpochMs != null && (
              <span className="cm-eta">
                arrive <Clock epoch={data.commute.etaEpochMs} />
              </span>
            )}
          </span>
        </div>
      )}
    </main>
  );
}
