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

- **`app/api/departures/route.ts`** serves the boards as JSON. By default it
  picks the view by New York time of day — morning (to the city), evening
  (heading home), late evening (tomorrow morning). `?direction=outbound` or
  `inbound` pins the direction instead: the sign at home always asks for trains
  to the city, and the web page has a switch. `?limit=` asks for more trains per
  board. The response reports the health of each data source in a `status` block
  — so the screens can say what's wrong instead of showing a plausible-looking
  empty board — and passes along NJ Transit's own service alerts.
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
| `HOME_ADDRESS` | Where drives start. Only ever sent to Google to measure drive times; never in the API response. |
| `GOOGLE_MAPS_API_KEY` | A Google Cloud API key with the **Routes API** enabled (billing on). Needed for drive times and "leave by". |
| `DRIVE_LIVE_HOURS` | New York hours in which drive times are re-measured. Default `6-8`. |
| `NJT_API_USERNAME` / `NJT_API_PASSWORD` | NJ Transit RailData credentials — enables the live board. |

### Drive times: measured by Google, never guessed

Every drive time is a real traffic-aware measurement from the Google Routes
API. During the morning hours when someone is about to leave (6–8 AM by
default) each destination is re-measured about every 5 minutes. The rest of the
day nothing is measured: the board keeps showing the most recent measurement and
marks it with a `~` ("~16 min drive"). That is 72 Google calls a day at most,
however many screens are open.

If Google can't be reached, the last measurement keeps being shown (marked `~`)
and the reason is logged. If Google has never answered — no key, or a key that
doesn't work — there is no drive time and no "leave by", and both screens say so
rather than guessing.

### Live trains

With RailData credentials set, each of today's boards is built from the live
departure board of the home station (Morristown or Bernardsville). Every train
there carries its full stop list, so one call gives departure and arrival times
in both directions. In the evening the city station's board adds the track and
"boarding" status at Penn / Hoboken.

NJ Transit allows about five logins a day, so one login token is shared across
server instances and deployments and replaced only when the API explicitly
rejects it — a timeout is never treated as a bad token. Without credentials, or if the live
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

## Knowing when it breaks

`.github/workflows/health.yml` looks at the live dashboard every hour during
the day (`scripts/health-check.mjs`; `npm run health` runs it by hand). If the
server isn't answering, the timetable is running out, NJ Transit live status or
Google drive times are gone, no trains are showing, or the E-Ink sign hasn't
checked in for 45 minutes, it opens one GitHub issue — which GitHub emails to
you — and closes it again when things are back to normal.

## Checks

`npm test` covers the timetable logic (including both daylight-saving days), the
live-board merge against real captured NJ Transit data, the login budget, the
drive-time schedule and its Google-call budget, that the API never leaks the
home address, and the contract with the sign: every field the firmware reads
must be in the response, and CI runs the firmware's real parser and renderer
over a sample of it.
`.github/workflows/ci.yml` runs them, the type check, the production build, a
firmware compile, and renders every E-Ink screen state on each push.
