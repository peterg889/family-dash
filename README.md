# Family Dashboard — NJ Transit

A wall/tablet dashboard — and an E-Ink sign (`firmware/`) — showing the **next
trains between Morristown / Bernardsville and New York / Hoboken**, with a
"leave the house by" time for each. Built with Next.js.

Near-term trains come from **NJ Transit's live departure board**, so the list is
what is actually running today (delays, tracks, cancellations, adjusted
schedules). A bundled copy of the public timetable fills in beyond that and
keeps the board working when the live feed isn't available.

## Quick start

```bash
npm install
cp .env.example .env.local    # optional: see "Configuration"
npm run dev                   # http://localhost:3000
npm test                      # unit tests
```

With no configuration at all the board runs on the bundled timetable alone.

## How it works

- **`app/api/departures/route.ts`** serves the boards as JSON. It picks the
  view by New York time of day — morning (to the city), evening (heading home),
  late evening (tomorrow morning) — and reports the health of each data source
  in a `status` block so the screens can say what's wrong instead of showing a
  plausible-looking empty board.
- **`lib/board.ts`** builds each board "live first": for as far ahead as NJ
  Transit's live board reaches (its next ~19 trains at the home station,
  usually 4–8 hours) the trains listed are the ones NJ Transit says are running;
  beyond that, and whenever live data is unavailable, the timetable fills in.
- **`lib/njtransit.ts`** talks to NJ Transit's RailData API (the data behind
  DepartureVision).
- **`lib/departures.ts`** answers "what's next" from the bundled timetable,
  handling `America/New_York`, daylight-saving days, and after-midnight
  (`24:xx`) GTFS times.
- **`lib/driving.ts`** supplies drive times for the "leave by" column.
- **`app/page.tsx`** renders the dashboard, refreshing every 30 seconds.

## Configuration

Everything is optional and lives in environment variables — `.env.local`
locally, the Vercel project settings in production. Nothing private belongs in
the repo. See `.env.example`.

| Variable | What it does |
| --- | --- |
| `DRIVE_TYPICAL_MIN` | Typical drive minutes per destination, e.g. `92=16,18=10,commute=15`. This is what "leave by" uses by default. |
| `HOME_ADDRESS` | Where drives start. Only ever sent to Google for live traffic; never in the API response. |
| `GOOGLE_MAPS_API_KEY` | Enables live traffic (Google Routes API). |
| `DRIVE_LIVE_HOURS` | New York hours in which to ask for live traffic. Default `5-11`. |
| `NJT_API_USERNAME` / `NJT_API_PASSWORD` | NJ Transit RailData credentials — enables the live board. |

### Drive times: typical first, live when it matters

Each destination has a **typical** drive time you set once. That alone gives
every train a "leave by", with nothing that can fail. **Live traffic** is an
optional refinement: if a Google key is configured, the server asks Google at
most once per destination per 10 minutes, and only during the morning hours
when someone is about to leave — about 100 calls a day at most, however many
screens are open. If Google is unconfigured, down, or the key stops working,
the board uses the typical time and marks it with a `~` ("~16 min drive"). The
reason for any Google failure is logged.

### Live trains

With RailData credentials set, each of today's boards is built from the live
departure board of the home station (Morristown or Bernardsville). Every train
there carries its full stop list, so one call gives departure and arrival times
in both directions. In the evening the city station's board adds the track and
"boarding" status at Penn / Hoboken.

NJ Transit allows about five logins a day, so the login token is shared across
server instances and replaced only when the API explicitly rejects it — a
timeout is never treated as a bad token. Without credentials, or if the live
feed is down, the board says so and shows the timetable.

## The timetable

`data/schedule.json` is a compact extract of NJ Transit's public rail GTFS feed,
built by `scripts/build-schedule.mjs` (no API key needed). It only covers a few
months of service dates, so it has to be refreshed:

- **Automatically:** `.github/workflows/refresh-schedule.yml` runs daily. If the
  trains changed it runs the tests and commits the new file to `main`. It fails
  — and GitHub emails you — if it can't get a usable feed or the timetable has
  under two weeks left.
- **By hand:** `npm run build:schedule`, then commit `data/schedule.json`.
  `npm run check:schedule` reports how many days are left.

If the timetable ever does expire, the API says so (`status.schedule.expired`)
and both screens show "timetable out of date" rather than "no trains".

## Changing stations

Edit the `ORIGINS` / `DESTINATIONS` maps at the top of
`scripts/build-schedule.mjs` (stop IDs come from the feed's `stops.txt`), run
`npm run build:schedule`, then update the `OUTBOUND` / `INBOUND` board lists in
`app/api/departures/route.ts` and the station codes in `lib/njtransit.ts`.

## Checks

`npm test` covers the timetable logic (including both daylight-saving days), the
live-board merge against real captured NJ Transit data, the login budget, the
drive-time fallbacks, and that the API never leaks the home address.
`.github/workflows/ci.yml` runs them, the type check, the production build, a
firmware compile, and renders every E-Ink screen state on each push.
