// firmware/src/buttons.cpp — see buttons.h.
//
// The CrowPanel has a small nav/toggle switch. Per Elecrow's pinout the
// rotary/nav switch is Up = GPIO6, Down = GPIO4 (active-low, so we pull them
// up and read LOW as pressed). If the physical up/down feel reversed, swap
// these two pins.
#include "buttons.h"
#include <Arduino.h>

#define BTN_UP_PIN 6
#define BTN_DOWN_PIN 4

static int up_prev = HIGH;
static int down_prev = HIGH;
static uint32_t last_evt_ms = 0;

void buttons_init(void) {
  pinMode(BTN_UP_PIN, INPUT_PULLUP);
  pinMode(BTN_DOWN_PIN, INPUT_PULLUP);
}

BtnEvent buttons_poll(void) {
  int up = digitalRead(BTN_UP_PIN);
  int down = digitalRead(BTN_DOWN_PIN);
  uint32_t now = millis();
  BtnEvent e = BTN_NONE;
  if (now - last_evt_ms > 200) {  // debounce
    if (up == LOW && up_prev == HIGH) {
      e = BTN_UP;
      last_evt_ms = now;
    } else if (down == LOW && down_prev == HIGH) {
      e = BTN_DOWN;
      last_evt_ms = now;
    }
  }
  up_prev = up;
  down_prev = down;
  return e;
}
