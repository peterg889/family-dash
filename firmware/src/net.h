// firmware/src/net.h — minimal WiFi lifecycle for the E-Paper board.
// WiFi's only purpose here is NTP time sync; see timekeeper.{h,cpp}.
#pragma once

#include <stdint.h>

typedef enum {
  NET_DISCONNECTED = 0,
  NET_CONNECTING,
  NET_CONNECTED,
} net_state_t;

// Start WiFi association, blocking until connected or `timeout_ms` elapses.
// Either way net_tick() manages the connection thereafter.
void net_init(uint32_t timeout_ms);
void net_tick(void);

net_state_t net_state(void);
const char* net_ssid(void);
const char* net_ip(void);  // "---" until associated
