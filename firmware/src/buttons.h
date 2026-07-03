// firmware/src/buttons.h — the board's up/down toggle for switching screens.
#pragma once

enum BtnEvent { BTN_NONE = 0, BTN_UP, BTN_DOWN };

void buttons_init(void);
// Call each loop; returns an event on a fresh press (debounced).
BtnEvent buttons_poll(void);
