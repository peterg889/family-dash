"use client";

import { useEffect, useState } from "react";

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
};

type Board = {
  origin: string;
  dest: string;
  destShort?: string;
  driveMin: number | null;
  departures: Departure[];
};

type Commute = {
  name: string;
  driveMin: number | null;
  etaEpochMs: number | null;
  mapsUrl: string;
};

type ApiResponse = {
  now: number;
  generatedAt: string;
  headline?: string;
  showLeave?: boolean;
  commute?: Commute;
  boards: Board[];
};

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
            <span className="drive">{board.driveMin} min drive</span>
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

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const res = await fetch("/api/departures", { cache: "no-store" });
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
  }, []);

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
        <a
          className="panel commute"
          href={data.commute.mapsUrl}
          target="_blank"
          rel="noreferrer"
        >
          <span className="cm-left">
            <span className="cm-kicker">school run · drive</span>
            <span className="cm-name">{data.commute.name}</span>
          </span>
          <span className="cm-right">
            <span className="cm-time">
              {data.commute.driveMin}
              <span className="cm-unit">min</span>
            </span>
            {data.commute.etaEpochMs != null && (
              <span className="cm-eta">
                arrive <Clock epoch={data.commute.etaEpochMs} />
              </span>
            )}
          </span>
        </a>
      )}
    </main>
  );
}
