--[==[badge-app
slug=consentinel
name=Consentinel
icon=CNS
api=2
heap_kb=96
wake_lock=1
confirm_home=1
version=0.8.0
author=Consentinel
]==]

-- Consentinel consent beacon (HTN 2026). MUST match shared/beacon.ts.
--   CONFIG -- large text, for the WEARER at arm's length.
--   BEACON -- black screen, the 3-digit KEY 208 px tall in GREEN (opt-in) or
--             RED (opt-out). Static; one frame decodes.
--
-- Shape carries identity, colour carries consent, and they are independent:
-- id(8) << 4 | crc4(id) = 12 bits = 3 hex digits. Digits 1-2 are the id,
-- digit 3 is the check digit. A misread digit fails CRC, and CRC = BLUR.

local BUTTON = badge.input.BUTTON
local PRESSED = badge.input.KIND.PRESSED

-- ---------------------------------------------------------------- geometry
-- ===> SET PATCH_W / PATCH_H. Everything else derives and centres itself. <===
-- PANEL_* verified on hardware with firmware/screen-ruler.lua.
local PANEL_X, PANEL_Y = 0, 0      -- cancels root's 30 px pad
local PANEL_W, PANEL_H = 320, 240      -- true ST7789 panel
local PATCH_W, PATCH_H = 320, 240      -- <-- BEACON SIZE. THIS IS THE KNOB.

local PATCH_X = (PANEL_W - PATCH_W) // 2
local PATCH_Y = (PANEL_H - PATCH_H) // 2

-- Margin keeps the strokes off the bezel, where glare and viewing angle eat
-- them first. Everything inside it is digits; there is no frame and no stripe.
local MARGIN = PATCH_W // 20                            -- 16 at 320
local CX, CY = PATCH_X + MARGIN, PATCH_Y + MARGIN
local CW, CH = PATCH_W - 2 * MARGIN, PATCH_H - 2 * MARGIN   -- 288x208

-- Boxes, not text: this LVGL build tops out at a 24 px font, unreadable at
-- camera distance. These are 208 px tall with a 22 px stroke.
local D_N    = 3
local D_GAP  = CW // 24                                 -- 12 at 288
local D_W    = (CW - (D_N - 1) * D_GAP) // D_N          -- 88 at 320
local D_H    = CH                                       -- 208 at 240
local D_T    = D_W // 4                                 -- 22 stroke
local D_HALF = (D_H - 3 * D_T) // 2                     -- 71
local D_X    = CX + (CW - (D_N * D_W + (D_N - 1) * D_GAP)) // 2
local D_Y    = CY

-- ----------------------------------------------------------------- colours
-- Undimmed. The DIGITS carry consent in their hue, RESTRICT-ONLY: a face
-- clears only when the chain record says opt-in AND the light says opt-in.
-- Pure primaries, so one channel is at 0 and argmax cannot be talked out of it.
local BASE_IN, BASE_OUT = 0x00FF00, 0xFF0000   -- GREEN / RED
local BASE_WHITE, OFF = 0xFFFFFF, 0x000000

-- Segment bits: 1 a(top) 2 b(top-right) 4 c(bottom-right) 8 d(bottom)
--              16 e(bottom-left) 32 f(top-left) 64 g(middle)
-- MUST match SEG in shared/beacon.ts.
local SEG = {
  0x3F, 0x06, 0x5B, 0x4F, 0x66, 0x6D, 0x7D, 0x07,   -- 0 1 2 3 4 5 6 7
  0x7F, 0x6F, 0x77, 0x7C, 0x39, 0x5E, 0x79, 0x71,   -- 8 9 A b C d E F
}

-- ------------------------------------------------------------- wire format
local ID_BITS, CRC_BITS = 8, 4                 -- MUST match shared/beacon.ts
local LED_LEVEL = 255       -- safe ONLY because the LEDs never blink
local STOPPED_MS, ALERT_MS = 2500, 6000
local RADIO_TAG = "CNS"
local BR_MIN, BR_MAX, BR_STEP = 30, 100, 5

-- ------------------------------------------------------------------- state
local st = {
  screen = 1,    -- 1 = config, 2 = beacon
  beacon_id = 0,
  consent = 0,   -- FAIL-SAFE: unset or unknown transmits OPT-OUT
  bright = 75,   -- percent
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

-- Scales all three channels by one factor, so hue is untouched and the
-- green/red decision survives. It changes luminance -- what a camera clips.
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
-- Rect of segment s (0..6) for a digit at x,y. Vertical budget is exactly
-- 3*D_T + 2*D_HALF = D_H. MUST match segRect in shared/beacon.ts.
local function seg_geom(s, x, y)
  local mid = y + D_T + D_HALF
  if s == 0 then return x + D_T, y, D_W - 2 * D_T, D_T end
  if s == 1 then return x + D_W - D_T, y + D_T, D_T, D_HALF end
  if s == 2 then return x + D_W - D_T, mid + D_T, D_T, D_HALF end
  if s == 3 then return x + D_T, y + D_H - D_T, D_W - 2 * D_T, D_T end
  if s == 4 then return x, mid + D_T, D_T, D_HALF end
  if s == 5 then return x, y + D_T, D_T, D_HALF end
  return x + D_T, mid, D_W - 2 * D_T, D_T
end

-- Repaint the digits. Never from on_tick. Digit 0 is the MSN. One colour for
-- every lit segment: consent is the hue, so it cannot disagree with itself.
local function paint_key()
  local p = payload()
  local lit = dim((st.consent == 1) and BASE_IN or BASE_OUT)
  for d = 0, D_N - 1 do
    local bits = SEG[((p >> (4 * (D_N - 1 - d))) & 0xF) + 1]
    for s = 0, 6 do
      ui.seg[d * 7 + s + 1]:style({
        bg_color = (((bits >> s) & 1) == 1) and lit or OFF })
    end
  end
end

-- --------------------------------------------------------------------- leds
-- Static: six WS2812s at 100 ms is a ~127 mA step that rings the boost
-- converter. Point sources, not a patch: a HUMAN channel only.
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
  ui.c_id:set_text(key_text())
  ui.c_id:style({ text_color = yes and BASE_IN or BASE_OUT })
  ui.c_cons:set_text(yes and "OPT-IN" or "OPT-OUT")
  ui.c_cons:style({ text_color = yes and BASE_IN or BASE_OUT })
  ui.c_rate:set_text(string.format("bright %d%%  leds %s  radio %s",
    st.bright, st.leds_on and "on" or "off",
    st.radio_on and (st.radio_ok and "on" or "FAIL") or "off"))
end

-- One banner widget, two messages. Never from on_tick.
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
    -- MAGENTA: the banner is on the hidden CONFIG screen while armed, so the
    -- LEDs are the only channel -- and red is already opt-out's resting state.
    notice("YOU WERE FILMED", 0xF87171, ALERT_MS, LED_LEVEL, 0, LED_LEVEL)
  elseif kind == "C" then
    -- RESTRICT-ONLY. The id is public (two of the three digits on screen), so
    -- an unsigned CNSC*1 would let anyone opt you IN. Opt-out is safe.
    if payload_str:sub(7, 7) == "0" and st.consent ~= 0 then
      st.consent = 0
      badge.store.set("consent", 0)
      paint_key() led_consent() refresh_config()
    end
  end
end

-- ---------------------------------------------------------------- lifecycle
-- ALWAYS derived, never stored: the registry uses this same FNV-1a hash, so
-- an override would stop matching the chain record. The basis MUST stay hex:
-- the decimal form exceeds INT_MAX here, parses as a float, and then fails
-- every bitwise operator.
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

  -- The one negative offset: cancels root's padding so ui.bg IS the panel.
  ui.bg = box(root, PANEL_W, PANEL_H, PANEL_X, PANEL_Y, OFF)

  -- Both screens built here, one hidden. No pcall on this badge, so every
  -- widget touched later must be created unconditionally.
  -- BEACON is black with nothing on it but 21 segment boxes: no frame, no
  -- stripe, nothing overlapping, so no z-order to get wrong.
  ui.bcn = box(ui.bg, PANEL_W, PANEL_H, 0, 0, OFF)
  for d = 0, D_N - 1 do
    local dx = D_X + d * (D_W + D_GAP)
    for s = 0, 6 do
      local x, y, w, h = seg_geom(s, dx, D_Y)
      ui.seg[d * 7 + s + 1] = box(ui.bcn, w, h, x, y, OFF)
    end
  end
  ui.bcn:hidden(true)

  -- Fonts are 14 and 24 only: the sizes this LVGL build is known to have.
  ui.cfg = box(ui.bg, PANEL_W, PANEL_H, 0, 0, 0x101014)
  local who = badge.me.name()
  ui.c_name = label(ui.cfg, (type(who) == "string" and #who > 0) and who
                    or "unprovisioned", 8, 0xE5E7EB, 24)
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
  -- Boot into CONFIG: the beacon is something you arm. Dark = no beacon = blur.
end

-- The key is static: all that is left on the hot path is expiring the banner.
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

  -- BEACON screen. UP/DOWN tune brightness live. EVERY other key stops the
  -- beacon: a wearer must always be able to stop broadcasting, unmissably.
  if st.screen == 2 then
    if button == BUTTON.UP then nudge_bright(BR_STEP) return end
    if button == BUTTON.DOWN then nudge_bright(-BR_STEP) return end
    show_config()
    refresh_config()
    notice("BEACON STOPPED", 0xFFBD00, STOPPED_MS, LED_LEVEL, 26, 0)
    return
  end

  if button == BUTTON.A then
    st.consent = (st.consent == 1) and 0 or 1
    badge.store.set("consent", st.consent)
    led_consent()
    -- The badge cannot sign: this is a REQUEST the registry client submits.
    radio_send(RADIO_TAG .. "R" .. hex2(st.beacon_id) .. tostring(st.consent))
    refresh_config()

  elseif button == BUTTON.UP then
    -- No store.set: save() on START and on_exit persists it already.
    nudge_bright(BR_STEP)
    refresh_config()

  elseif button == BUTTON.DOWN then
    nudge_bright(-BR_STEP)
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
