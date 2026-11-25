// firmware/src/config.h — non-secret device configuration.
// (WiFi credentials and the OTA password live in wifi_config.h, gitignored.)
#pragma once

// America/New_York with US DST rules (DST: 2nd Sun Mar .. 1st Sun Nov).
// Every countdown and clock time on the screen depends on this being set.
#define TZ_POSIX "EST5EDT,M3.2.0,M11.1.0"

// NTP servers used to set the clock once WiFi is up.
#define NTP_SERVER_1 "pool.ntp.org"
#define NTP_SERVER_2 "time.nist.gov"
#define NTP_SERVER_3 "time.google.com"

// Live family-dash board (departures, live NJ Transit status and "leave by"
// times, all computed server-side). The device fetches and renders this.
#define BOARD_API_URL "https://family-dash-beta.vercel.app/api/departures"

// How often to swap between the two station screens (Morristown /
// Bernardsville). Each swap is a full refresh, which also re-ticks the
// countdowns from the local clock.
#define ROTATE_INTERVAL_MS 30000UL  // 30 s per screen

// How often to refetch the board after a GOOD fetch. Kept well above the
// render cadence: departures change slowly and the server caches upstream calls.
#define FETCH_INTERVAL_MS 180000UL  // 3 min

// How soon to try again after a FAILED fetch. (A fetch is also made at once
// whenever WiFi reconnects or the clock is first set.)
#define FETCH_RETRY_MS 30000UL  // 30 s

// WiFi association timeout during setup() before we proceed anyway.
#define WIFI_CONNECT_TIMEOUT_MS 20000UL

// ---- self-healing -----------------------------------------------------------

// Task watchdog: if loop() stops coming round for this long (a hung TLS
// handshake, a stuck panel), the chip resets itself. Must comfortably exceed
// the longest legitimate blocking step (a fetch: ~25 s worst case).
#define WDT_TIMEOUT_S 60

// Reboot once a night while nobody is looking, to shed heap fragmentation and
// any stuck network state. Only when up long enough that it can't loop.
#define NIGHTLY_REBOOT_HOUR 3
#define NIGHTLY_REBOOT_MINUTE 30
#define NIGHTLY_MIN_UPTIME_MS (6UL * 3600UL * 1000UL)

// Reboot if the network looks wedged for this long: WiFi "connected" but no
// HTTP exchange completing, or WiFi unable to associate at all. Not before the
// device has been up an hour, so it can restart at most once an hour.
#define STUCK_RESTART_MS (30UL * 60UL * 1000UL)
#define STUCK_MIN_UPTIME_MS (60UL * 60UL * 1000UL)

// ---- over-the-air updates ---------------------------------------------------

// mDNS name the board answers to for `flash-ota.sh` (family-dash-eink.local).
// OTA is only enabled when wifi_config.h defines OTA_PASSWORD.
#define OTA_HOSTNAME "family-dash-eink"
