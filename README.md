# Family Dashboard — NJ Transit

A simple wall/tablet dashboard showing the **next trains to New York and
Hoboken from Morristown and Bernardsville**, built with Next.js.

It uses NJ Transit's **public GTFS static schedule feed** — no API key or
developer registration required. Times shown are *scheduled* departures
(not real-time delays/track assignments; see "Going real-time" below).

## Quick start

```bash
npm install
npm run dev        # http://localhost:3000
```

For an always-on display:

```bash
npm run build
npm run start
```

## How it works

- **`scripts/build-schedule.mjs`** downloads NJ Transit's rail GTFS feed
  (from the public Mobility Database mirror), keeps only the trips that run
  between the four stations we care about, and writes a tiny
  **`data/schedule.json`** (~20 KB).
- **`lib/departures.ts`** computes the next departures from that file for the
  current time, correctly handling the `America/New_York` timezone and
  after-midnight (`24:xx`, `25:xx`) GTFS times.
- **`app/api/departures/route.ts`** serves the four boards as JSON.
- **`app/page.tsx`** renders the dashboard with a live clock, per-train
  countdowns, and a refresh every 30 seconds.

## Refreshing the schedule

NJ Transit updates the GTFS feed periodically. To pull the latest:

```bash
npm run build:schedule
```

This rewrites `data/schedule.json`. Commit the result.

## Changing stations

Edit the `ORIGINS` / `DESTINATIONS` maps at the top of
`scripts/build-schedule.mjs` (stop IDs come from the feed's `stops.txt`),
then run `npm run build:schedule`. Update the `BOARDS` list in
`app/api/departures/route.ts` to match.

## Going real-time (optional, later)

This dashboard shows the *published schedule*. To show live delays, track
assignments, and "ALL ABOARD" status, register for the
[NJ Transit developer portal](https://developer.njtransit.com/registration/)
to get RailData API credentials, then add a server-side proxy that merges
real-time status into the board. The current architecture (server API route
holding any secrets, frontend polling JSON) is already set up for this.
