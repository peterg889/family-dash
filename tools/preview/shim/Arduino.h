// Minimal Arduino shim to compile Adafruit_GFX + ui.cpp natively for previews.
#pragma once
#include <cstdint>
#include <cstddef>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>

using String = std::string;
typedef bool boolean;
typedef uint8_t byte;

#define PROGMEM
#define PSTR(s) (s)
#define F(s) (s)
#define pgm_read_byte(a) (*(const uint8_t *)(a))
#define pgm_read_word(a) (*(const uint16_t *)(a))
#define pgm_read_dword(a) (*(const uint32_t *)(a))
#define pgm_read_pointer(a) ((void *)*(const uintptr_t *)(a))
#define pgm_read_byte_near(a) pgm_read_byte(a)
#define memcpy_P memcpy
#define strlen_P strlen

class __FlashStringHelper;

#include "Print.h"

#ifndef PI
#define PI 3.1415926535897932384626433832795
#endif
#define radians(deg) ((deg) * PI / 180.0)
#define degrees(rad) ((rad) * 180.0 / PI)

#ifndef min
#define min(a, b) (((a) < (b)) ? (a) : (b))
#endif
#ifndef max
#define max(a, b) (((a) > (b)) ? (a) : (b))
#endif
