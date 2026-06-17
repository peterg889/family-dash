"use client";

import { useEffect, useState } from "react";

type Departure = {
  depEpochMs: number;
  depTime: string;
  arrTime: string;
  routeName: string;
  routeShort: string;
  color: string;
  headsign: string;
  durationMin: number;
};

type Board = {
  origin: string;
  dest: string;
  note?: string;
  departures: Departure[];
};

type ApiResponse = {
  now: number;
  generatedAt: string;
  boards: Board[];
};

const REFRESH_MS = 30_000;

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bNy\b/, "NY");
}

function Countdown({ depEpochMs, now }: { depEpochMs: number; now: number }) {
  const mins = Math.round((depEpochMs - now) / 60000);
  let cls = "countdown";
  let label: string;
  if (mins <= 0) {
    cls += " now";
    label = "now";
  } else if (mins < 5) {
    cls += " soon";
    label = `${mins} min`;
  } else if (mins < 60) {
    label = `${mins} min`;
  } else {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    label = m ? `${h}h ${m}m` : `${h}h`;
  }
  return (
    <div className={cls}>
      <div className="big">{mins <= 0 ? "now" : label}</div>
      {mins > 0 && <div className="unit">until departure</div>}
    </div>
  );
}

function BoardCard({ board, now }: { board: Board; now: number }) {
  return (
    <div className="board">
      <div className="board-head">
        <span className="from">{titleCase(board.origin)}</span>
        <span className="arrow">→</span>
        <span className="to">{titleCase(board.dest)}</span>
      </div>
      {board.note && <div className="board-note">{board.note}</div>}
      {board.departures.length === 0 ? (
        <div className="empty">No more trains scheduled.</div>
      ) : (
        board.departures.map((d) => (
          <div className="train" key={d.depEpochMs + d.headsign}>
            <div
              className="line-badge"
              style={{ background: `#${d.color}` }}
              title={d.routeName}
            />
            <div className="deptime">{d.depTime}</div>
            <div className="meta">
              <div className="headsign">{titleCase(d.headsign)}</div>
              <div className="sub">
                {d.routeName} · arrives {d.arrTime} · {d.durationMin} min
              </div>
            </div>
            <Countdown depEpochMs={d.depEpochMs} now={now} />
          </div>
        ))
      )}
    </div>
  );
}

export default function Page() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fetchedAt, setFetchedAt] = useState(0);
  const [error, setError] = useState(false);

  // Tick the local clock every second for live countdowns.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Refetch the schedule periodically.
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
  const clockDate = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "long",
    month: "long",
    day: "numeric",
  }).format(now);

  const stale = fetchedAt > 0 && now - fetchedAt > REFRESH_MS * 2;

  return (
    <main className="dashboard">
      <div className="topbar">
        <div>
          <h1>Next Trains</h1>
          <div className="subtitle">
            To New York &amp; Hoboken from Morristown &amp; Bernardsville
          </div>
        </div>
        <div className="clock">
          <div className="time">{clockTime}</div>
          <div className="date">{clockDate}</div>
        </div>
      </div>

      {data ? (
        <div className="grid">
          {data.boards.map((b) => (
            <BoardCard key={b.origin + b.dest} board={b} now={now} />
          ))}
        </div>
      ) : (
        <div className="empty">
          {error ? "Couldn’t load schedule." : "Loading…"}
        </div>
      )}

      <div className="footer">
        <span className={`dot${stale || error ? " stale" : ""}`} />
        {error
          ? "Reconnecting…"
          : stale
            ? "Reconnecting…"
            : "Live · updates every 30s"}{" "}
        · Scheduled times from NJ Transit GTFS feed
        {data ? ` (${data.generatedAt.slice(0, 10)})` : ""}
      </div>
    </main>
  );
}
