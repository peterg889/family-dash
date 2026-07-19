# Family Dashboard — NJ Transit

A simple wall/tablet dashboard showing the **next trains to New York and
Hoboken from Morristown and Bernardsville**, built with Next.js.

It uses NJ Transit's **public GTFS static schedule feed** for the backbone
schedule (no API key required), and — when RailData API credentials are
configured — layers **real-time DepartureVision status** (delays, track
assignments, "ALL ABOARD", cancellations) on top. See "Real-time status" below.

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

## Real-time status

The GTFS schedule is the backbone; **`lib/njtransit.ts`** layers live status on
top from NJ Transit's [RailData API](https://developer.njtransit.com/) (the same
data as DepartureVision). Each train on today's boards can show a live **delay**,
**track**, **"ALL ABOARD"**, or **cancellation**.

To enable it, set two environment variables (locally in `.env.local`, in
production in the Vercel project settings) with your RailData API credentials:

```bash
NJT_API_USERNAME=your-username
NJT_API_PASSWORD=your-password
# optional: override the API base URL (defaults to the raildata.njtransit.com Train Data API)
# NJT_API_BASE=https://raildata.njtransit.com/api/TrainData
```

Without them, the board runs on the GTFS schedule alone (every train's `live`
field is simply `null`) — nothing breaks. The credentials are only ever read
server-side in the API route; they never reach the browser or the E-Ink device.

How it works: the client fetches a token (`getToken`), pulls each origin
station's live board (`getTrainSchedule`), and matches a live train to a
scheduled departure by its scheduled minute. Token and per-station boards are
cached to stay well under NJ Transit's daily request limits. Real-time data only
exists for the near term, so the "next morning" preview stays schedule-only.
