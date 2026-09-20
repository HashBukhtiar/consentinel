--[==[badge-app
slug=consentinel
name=Consentinel
icon=CNS
api=2
heap_kb=96
wake_lock=1
confirm_home=1
version=0.4.0
author=Consentinel
]==]

-- Consentinel consent beacon (HTN 2026).
--   CONFIG screen -- large text, for the WEARER at arm's length.
--   BEACON screen -- a STATIC key the camera reads: white ring + three giant
--     hex digits. No blinking, no timing, no clock recovery. One frame is
--     enough to decode, so dropped frames and a variable call frame rate
--     stop mattering.
--
-- The key is the 12-bit payload shared/beacon.ts already defines:
--   id(8) << 4 | crc4(id)   ->  3 hex digits, e.g. id 0x1A -> "1A9"
-- so packPayload / unpackPayload on the decoder side work unchanged. A
-- misread digit fails CRC, and a CRC failure means BLUR -- never guess.
--
-- Digits are drawn as 7-segment boxes, not text: the fonts this LVGL build
-- has top out at 24 px, which is unreadable at any camera distance. These are
-- 160 px tall.

local BUTTON = badge.input.BUTTON
local PRESSED = badge.input.KIND.PRESSED

-- ---------------------------------------------------------------- geometry
-- ST7789, fixed. PAD escapes the padding on root: a child placed at -PAD
-- lands on screen pixel 0, so every coordinate below is "screen minus PAD".
local PAD = 30
local PATCH_W, PATCH_H = 320, 240
local POS_X, POS_Y = -PAD, -PAD

-- The ring's geometry is kept (the digit grid is laid out inside it and the
-- decoder's KEY contract in shared/beacon.ts depends on that), but the ring
-- is painted BLACK now: the static-key decoder never reads it, and on a webcam
-- at 0.5-1 m its blown-out white bloomed 2-6 px into the digits next to it,
-- which lit the last digit's bottom segment and drowned a trailing '1'. Set
-- RING to BASE_WHITE to get the old look back.
local BORDER = 24
local RING = 0x000000
local IN_X, IN_Y = POS_X + BORDER, POS_Y + BORDER
local IN_W, IN_H = PATCH_W - 2 * BORDER, PATCH_H - 2 * BORDER  -- 272 x 192

-- Three digits across the interior.
local D_N, D_W, D_H, D_T, D_GAP = 3, 76, 160, 18, 14
local D_HALF = (D_H - 3 * D_T) // 2                            -- 53
local D_X = IN_X + (IN_W - (D_N * D_W + (D_N - 1) * D_GAP)) // 2
local D_Y = IN_Y + (IN_H - D_H) // 2

-- Segment bits: 1 a(top) 2 b(top-right) 4 c(bottom-right) 8 d(bottom)
--              16 e(bottom-left) 32 f(top-left) 64 g(middle)
local SEG = {
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,   -- 0 1 2 3 4 5 6 7
  0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71,   -- 8 9 A B C D E F
}

-- ----------------------------------------------------------------- colours
-- Undimmed. Digit colour carries consent, RESTRICT-ONLY: a face clears only
-- when the chain record says opt-in AND the light says opt-in.
local BASE_IN, BASE_OUT = 0x00FF84, 0xFF0084   -- MINT / ROSE
local BASE_WHITE, OFF = 0xFFFFFF, 0x000000

-- ------------------------------------------------------------- wire format
local ID_BITS, CRC_BITS = 8, 4                 -- MUST match shared/beacon.ts
-- 255 blew the LEDs out to a 25 px white-cored halo at 1 m on a 1080p webcam,
-- hugging the display's corners; the decoder now filters those, but at 64 the
-- halo is a quarter the size and the colour still reads across a room.
local LED_LEVEL = 64        -- safe ONLY because the LEDs never blink
local STOPPED_MS, ALERT_MS = 2500, 6000
local RADIO_TAG = "CNS"
local BR_MIN, BR_MAX, BR_STEP = 30, 100, 5

-- ------------------------------------------------------------------- state
local st = {
  screen = 1,    -- 1 = config, 2 = beacon
  beacon_id = 0,
  consent = 0,   -- FAIL-SAFE: unset or unknown transmits OPT-OUT
  bright = 75,   -- percent. Aim for a measured ring luma of 190-210.
  leds_on = true,
  radio_on = false,
  radio_ok = false,
  note_until = 0,
  note_on = false,
}
local ui = { seg = {} }

-- ------------------------------------------------------------------- utils
local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end

local HEXDIG = "0123456789ABCDEF"

local function hex2(v)
  local hi, lo = (v >> 4) & 0xF, v & 0xF
  return HEXDIG:sub(hi + 1, hi + 1) .. HEXDIG:sub(lo + 1, lo + 1)
end

-- Scales the digits AND the ring by one factor, so every ratio the decoder
-- sees is unchanged. What it does change is absolute luminance -- the thing a
-- camera clips. Clipped means digits == ring == white and the key is gone.
local function dim(c)
  local b = st.bright
  return (((((c >> 16) & 0xFF) * b) // 100) << 16)
       | (((((c >> 8) & 0xFF) * b) // 100) << 8)
       | ((((c & 0xFF) * b) // 100))
end

-- CRC-4, polynomial x^4 + x + 1 (0b10011). MUST match crc4 in shared/beacon.ts.
local function crc4(value, nbits)
  local reg = 0
  for i = nbits - 1, 0, -1 do
    local top = (reg >> 3) & 1
    reg = ((reg << 1) | ((value >> i) & 1)) & 0xF
    if top == 1 then reg = reg ~ 0x3 end
  end
  return reg & 0xF
end

-- id(8) << 4 | crc4(id). MUST match packPayload.
local function payload()
  local id = st.beacon_id & 0xFF
  return (id << CRC_BITS) | crc4(id, ID_BITS)
end

local function key_text()
  local p = payload()
  local a, b, c = (p >> 8) & 0xF, (p >> 4) & 0xF, p & 0xF
  return HEXDIG:sub(a + 1, a + 1) .. HEXDIG:sub(b + 1, b + 1)
      .. HEXDIG:sub(c + 1, c + 1)
end

-- --------------------------------------------------------------- the digits
-- One 7-segment digit, laid out from its top-left corner.
local function seg_geom(dx, s)
  local T, W, H, Hf = D_T, D_W, D_H, D_HALF
  if s == 1 then return dx + T,     D_Y,                W - 2 * T, T  end
  if s == 2 then return dx + W - T, D_Y + T,            T,         Hf end
  if s == 3 then return dx + W - T, D_Y + 2 * T + Hf,   T,         Hf end
  if s == 4 then return dx + T,     D_Y + H - T,        W - 2 * T, T  end
  if s == 5 then return dx,         D_Y + 2 * T + Hf,   T,         Hf end
  if s == 6 then return dx,         D_Y + T,            T,         Hf end
  return             dx + T,        D_Y + T + Hf,       W - 2 * T, T
end

-- Repaint ring + digits. Called on any change to id, consent or brightness;
-- never from on_tick.
local function paint_key()
  local on = dim((st.consent == 1) and BASE_IN or BASE_OUT)
  local p = payload()
  ui.frame:style({ bg_color = dim(RING) })
  for d = 0, D_N - 1 do
    local nibble = (p >> (4 * (D_N - 1 - d))) & 0xF
    local mask = SEG[nibble + 1]
    for s = 1, 7 do
      local lit = (mask >> (s - 1)) & 1
      ui.seg[d * 7 + s]:style({ bg_color = (lit == 1) and on or OFF })
    end
  end
end

-- --------------------------------------------------------------------- leds
-- Static, never blinking: six WS2812s switching every 100 ms is a ~127 mA
-- step that rings the boost converter. Six point sources 25 mm apart are not
-- a patch the localizer can rectify, so these are a HUMAN channel only.
local function led_consent()
  if not st.leds_on then
    badge.led.clear() badge.led.show() return
  end
  if st.consent == 1 then badge.led.set_all(0, LED_LEVEL, 0)
  else badge.led.set_all(LED_LEVEL, 0, 0) end
  badge.led.show()
end

-- ----------------------------------------------------------------------- ui
local function refresh_config()
  local yes = st.consent == 1
  ui.c_id:set_text("KEY " .. key_text())
  ui.c_cons:set_text(yes and "OPT-IN" or "OPT-OUT")
  ui.c_cons:style({ text_color = yes and BASE_IN or BASE_OUT })
  ui.c_rate:set_text(string.format("id %s  bright %d%%  leds %s  radio %s",
    hex2(st.beacon_id), st.bright, st.leds_on and "on" or "off",
    st.radio_on and (st.radio_ok and "on" or "FAIL") or "off"))
end

-- One banner widget, two messages. Never called from on_tick: LED writes and
-- NVS commits stay off the hot path.
local function notice(text, colour, ms, r, g, b)
  ui.c_ban:set_text(text)
  ui.c_ban:style({ text_color = colour })
  ui.c_ban:hidden(false)
  st.note_until = badge.sys.ms() + ms
  st.note_on = true
  if st.leds_on then badge.led.set_all(r, g, b) badge.led.show() end
end

local function show_beacon()
  st.screen = 2
  paint_key()
  ui.cfg:hidden(true)
  ui.bcn:hidden(false)
end

local function show_config()
  st.screen = 1
  ui.bcn:hidden(true)
  ui.cfg:hidden(false)
end

-- -------------------------------------------------------------------- radio
local function radio_send(msg)
  if st.radio_on and st.radio_ok then badge.radio.send(msg) end
end

local function on_radio(mac, rssi, payload_str)
  if type(payload_str) ~= "string" or #payload_str < 6 then return end
  if payload_str:sub(1, 3) ~= RADIO_TAG then return end
  local kind = payload_str:sub(4, 4)
  local id = tonumber(payload_str:sub(5, 6), 16)
  if id == nil or id ~= st.beacon_id then return end

  if kind == "F" then
    notice("YOU WERE FILMED", 0xF87171, ALERT_MS, LED_LEVEL, 0, 0)
  elseif kind == "C" then
    local s = payload_str:sub(7, 7)
    if s == "1" or s == "0" then
      st.consent = (s == "1") and 1 or 0
      badge.store.set("consent", st.consent)
      paint_key() led_consent() refresh_config()
    end
  end
end

-- ---------------------------------------------------------------- lifecycle
-- ALWAYS derived, never stored: the registry derives the id from this same
-- FNV-1a hash, so an override would silently stop matching the chain record.
-- The offset basis MUST be hex -- this badge has 32-bit integers in Lua, and
-- the decimal form exceeds INT_MAX, parses as a float, and then fails every
-- bitwise operator. Overflow wraps two-s complement, which is what FNV wants.
local function derive_beacon_id()
  local bid = badge.me.badge_id()
  if type(bid) ~= "string" or #bid == 0 then return 0 end
  local h = 0x811C9DC5
  for i = 1, #bid do
    h = (h ~ bid:byte(i)) & 0xFFFFFFFF
    h = (h * 16777619) & 0xFFFFFFFF
  end
  return ((h >> 24) ~ (h >> 16) ~ (h >> 8) ~ h) & 0xFF
end

local function save()
  badge.store.set("consent", st.consent)
  badge.store.set("bright", st.bright)
  badge.store.set("leds", st.leds_on and 1 or 0)
end

local function box(parent, w, h, x, y, colour)
  local b = badge.ui.box(parent, w, h)
  b:set_pos(x, y)
  b:style({ bg_color = colour, radius = 0, border_width = 0, pad_all = 0 })
  return b
end

local function label(parent, text, y, colour, font)
  local l = badge.ui.label(parent, text)
  l:set_pos(12, y)
  l:style({ text_color = colour, text_font = font })
  return l
end

function on_enter(root)
  -- Default 0 on every read: an unprovisioned or wiped badge transmits
  -- OPT-OUT. Opt-in is something the wearer does, never a default.
  st.consent = clamp(badge.store.get_int("consent", 0), 0, 1)
  st.bright  = clamp(badge.store.get_int("bright", 75), BR_MIN, BR_MAX)
  st.leds_on = badge.store.get_int("leds", 1) == 1
  st.beacon_id = derive_beacon_id()

  ui.bg = box(root, PATCH_W, PATCH_H, 0, 0, OFF)

  -- Both screens are built here and one is hidden. There is no pcall on this
  -- badge, so a stale widget reference is an unrecoverable kill. Every widget
  -- touched later is created unconditionally.
  ui.bcn = box(ui.bg, PATCH_W, PATCH_H, 0, 0, OFF)

  -- The ring is a white box UNDERNEATH the interior, not set_border() plus
  -- pad_all: two absolutely positioned siblings cannot disagree about inset
  -- semantics. PATCH_* is the TRUE panel size, so the ring closes on all four
  -- edges -- oversizing it runs the right and bottom off-screen and leaves
  -- the localizer an open quad it cannot rectify.
  ui.frame = box(ui.bcn, PATCH_W, PATCH_H, POS_X, POS_Y, RING)
  ui.inner = box(ui.bcn, IN_W, IN_H, IN_X, IN_Y, OFF)
  ui.inner:bring_to_front()

  for d = 0, D_N - 1 do
    local dx = D_X + d * (D_W + D_GAP)
    for s = 1, 7 do
      local x, y, w, h = seg_geom(dx, s)
      local b = box(ui.bcn, w, h, x, y, OFF)
      b:bring_to_front()
      ui.seg[d * 7 + s] = b
    end
  end
  ui.bcn:hidden(true)

  -- Fonts are 14 and 24 only: the sizes this LVGL build is known to have.
  ui.cfg = box(ui.bg, PATCH_W, PATCH_H, 0, 0, 0x101014)
  local who = badge.me.name()
  ui.c_name = label(ui.cfg, type(who) == "string" and who or "unprovisioned",
                    8, 0xE5E7EB, 24)
  ui.c_id   = label(ui.cfg, "", 44, BASE_WHITE, 24)
  ui.c_cons = label(ui.cfg, "", 80, BASE_WHITE, 24)
  ui.c_rate = label(ui.cfg, "", 116, 0x9CA3AF, 14)
  ui.c_keys = label(ui.cfg, "A opt  UP/DN bright  L led  R radio",
                    146, 0x6B7280, 14)
  ui.c_go   = label(ui.cfg, "START = BEACON", 168, 0xFFBD00, 24)
  ui.c_ban  = label(ui.cfg, "", 206, BASE_WHITE, 14)
  ui.c_ban:hidden(true)

  refresh_config()
  led_consent()
  -- Boot into CONFIG: the beacon is something you arm. A reboot mid-demo
  -- leaves the badge dark, which reads as "no beacon" and so as "blur".
end

-- The key is static, so the only thing left on the hot path is expiring the
-- banner. Nothing here touches the beacon screen.
function on_tick()
  if st.note_on and badge.sys.ms() >= st.note_until then
    st.note_on = false
    ui.c_ban:hidden(true)
    led_consent()
  end
end

local function nudge_bright(d)
  st.bright = clamp(st.bright + d, BR_MIN, BR_MAX)
  paint_key()
end

function on_button(button, kind)
  if kind ~= PRESSED then return end
  local now = badge.sys.ms()

  -- BEACON screen. UP/DOWN tune brightness live, so you can chase a ring luma
  -- of 190-210 on the call without re-pushing. EVERY other key stops the
  -- beacon -- a wearer who wants to stop broadcasting must always be able to,
  -- and the stop is impossible to miss: the key disappears, large text
  -- returns, amber banner and amber LEDs hold for 2.5 s.
  if st.screen == 2 then
    if button == BUTTON.UP then nudge_bright(BR_STEP) return end
    if button == BUTTON.DOWN then nudge_bright(-BR_STEP) return end
    show_config()
    refresh_config()
    if now >= st.note_until then
      notice("BEACON STOPPED", 0xFFBD00, STOPPED_MS, LED_LEVEL, 26, 0)
    end
    return
  end

  if button == BUTTON.A then
    st.consent = (st.consent == 1) and 0 or 1
    badge.store.set("consent", st.consent)
    led_consent()
    -- The badge holds no keypair and cannot sign: this is a REQUEST the
    -- registry client signs and submits.
    radio_send(RADIO_TAG .. "R" .. hex2(st.beacon_id) .. tostring(st.consent))
    refresh_config()

  elseif button == BUTTON.UP then
    nudge_bright(BR_STEP)
    badge.store.set("bright", st.bright)
    refresh_config()

  elseif button == BUTTON.DOWN then
    nudge_bright(-BR_STEP)
    badge.store.set("bright", st.bright)
    refresh_config()

  elseif button == BUTTON.LEFT then
    st.leds_on = not st.leds_on
    badge.store.set("leds", st.leds_on and 1 or 0)
    led_consent()
    refresh_config()

  elseif button == BUTTON.RIGHT then
    if st.radio_on then
      st.radio_on, st.radio_ok = false, false
      badge.radio.disable()
    else
      st.radio_on = true
      st.radio_ok = badge.radio.enable() and true or false
      if st.radio_ok then badge.radio.on_recv(on_radio) end
    end
    refresh_config()

  elseif button == BUTTON.START then
    -- SAVE, then arm. store.set writes NVS flash and can block tens of ms.
    save()
    show_beacon()
  end
end

function on_exit()
  badge.led.clear()
  badge.led.show()
  if st.radio_on then badge.radio.disable() end
  save()
end
