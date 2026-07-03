// firmware/src/config.h — non-secret device configuration.
// (WiFi credentials live in wifi_config.h, which is gitignored.)
#pragma once

// America/New_York with US DST rules (DST: 2nd Sun Mar .. 1st Sun Nov).
// The whole departures computation depends on this being set.
#define TZ_POSIX "EST5EDT,M3.2.0,M11.1.0"

// NTP servers used to set the clock once WiFi is up.
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.nist.gov"
#define NTP_SERVER_3 "time.google.com"

// Live family-dash board (departures + traffic-aware "leave by" times, computed
// server-side via Google Maps). The device fetches and renders this.
#define BOARD_API_URL "https://family-dash-beta.vercel.app/api/departures"

// How often to swap between the two screens (leave / board). Each swap is a
// full refresh (the layouts differ), which also refreshes the countdowns.
#define ROTATE_INTERVAL_MS 30000UL  // 30 s per screen

// How often to refetch the board from the API. Kept well above the render
// cadence: traffic/departures change slowly, and this bounds Google Maps cost
// if the server recomputes per request. (Server-side caching is still wise.)
#define FETCH_INTERVAL_MS 180000UL  // 3 min

// WiFi association timeout during setup() before we proceed anyway.
#define WIFI_CONNECT_TIMEOUT_MS 20000UL
