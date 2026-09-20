--[==[badge-app
slug=consentinel
name=Consentinel
icon=CNS
api=2
heap_kb=96
wake_lock=1
confirm_home=1
version=0.2.0
author=Consentinel
]==]
local BUTTON = badge.input.BUTTON
local PRESSED = badge.input.KIND.PRESSED
local SCREEN_W = 380
local SCREEN_H = 300
local POS_X = -30
local POS_Y = -30
local BORDER = 24
local IN_W = SCREEN_W - 2 * BORDER
local IN_H = SCREEN_H - 2 * BORDER
local BRIGHT = 0.75
local function dim(rgb)
  local r = math.floor(((rgb >> 16) & 0xFF) * BRIGHT)
  local g = math.floor(((rgb >> 8) & 0xFF) * BRIGHT)
  local b = math.floor((rgb & 0xFF) * BRIGHT)
  return (r << 16) | (g << 8) | b
end
local DATA_COLOR = {
  dim(0x000000), dim(0x0082FF), dim(0x84FF00), dim(0xFF8200), dim(0x0000FF),
}
local RADIX = 5
local MARK_IN = dim(0x00FF84)  -- MARK_OPT_IN,  index 5 (MARK_IN_INDEX)
local MARK_OUT = dim(0xFF0084) -- MARK_OPT_OUT, index 6 (MARK_OUT_INDEX)
local WHITE = dim(0xFFFFFF)
local ID_BITS = 8    -- MUST match ID_BITS
local MSG_BITS = 10  -- MUST match MSG_BITS
local CRC_BITS = 6   -- MUST match CRC_BITS
local CRC_TAP = 0x03 -- x^6 + x + 1; MUST match the tap in crc6()
local PAYLOAD_BITS = MSG_BITS + CRC_BITS -- 16,  MUST match PAYLOAD_BITS
local BITS_PER_SYMBOL = 2                -- MUST match BITS_PER_SYMBOL
local DATA_SYMBOLS = PAYLOAD_BITS // BITS_PER_SYMBOL -- 8,  MUST match
local SYMBOLS = 1 + DATA_SYMBOLS         -- 9,  MUST match SYMBOLS_PER_FRAME
local TIMING_MS = { 80, 100, 120, 150 }
local DEFAULT_TIMING = 2
local LED_LEVEL = 255
local STOPPED_MS = 2500
local ALERT_MS = 6000
local RADIO_TAG = "CNS"
local st = {
  screen = 1,   -- 1 = config, 2 = beacon. Integer, not a string: cheaper.
  beacon_id = 0,
  consent = 0,  -- FAIL-SAFE: unset or unknown transmits OPT-OUT, never opt-in
  timing = DEFAULT_TIMING,
  leds_on = true,
  radio_on = false,
  radio_ok = false,
  t0 = 0,
  last_slot = -1,
  note_until = 0,
  note_on = false,
  frame = nil,  -- 9 colours; rebuilt only when id or consent changes
}
local ui = {}
local function clamp(v, lo, hi)
  if v < lo then return lo end
  if v > hi then return hi end
  return v
end
local function hex2(v)
  local digits = "0123456789ABCDEF"
  local hi = (v >> 4) & 0xF
  local lo = v & 0xF
  return digits:sub(hi + 1, hi + 1) .. digits:sub(lo + 1, lo + 1)
end
local function crc6(value, nbits)
  local reg = 0
  for i = nbits - 1, 0, -1 do
    local bit = (value >> i) & 1
    local top = (reg >> 5) & 1
    reg = ((reg << 1) | bit) & 0x3F
    if top == 1 then reg = reg ~ CRC_TAP end
  end
  return reg & 0x3F
end
local function symbol_ms()
  return TIMING_MS[st.timing]
end
local function build_frame()
  local msg = ((st.beacon_id & 0xFF) << (MSG_BITS - ID_BITS))
    | ((st.consent == 1) and 2 or 0) -- reserved low bit stays 0
  local payload = (msg << CRC_BITS) | crc6(msg << CRC_BITS, PAYLOAD_BITS)
  local f = { (st.consent == 1) and MARK_IN or MARK_OUT }
  local prev = 0
  for k = 0, DATA_SYMBOLS - 1 do
    local b = (payload >> (PAYLOAD_BITS - BITS_PER_SYMBOL * (k + 1))) & 3
    prev = (prev + 1 + b) % RADIX
    f[k + 2] = DATA_COLOR[prev + 1]
  end
  st.frame = f
end
local function led_consent()
  if not st.leds_on then
    badge.led.clear()
    badge.led.show()
    return
  end
  if st.consent == 1 then
    badge.led.set_all(0, LED_LEVEL, 0)
  else
    badge.led.set_all(LED_LEVEL, 0, 0)
  end
  badge.led.show()
end
local function refresh_config()
  local yes = st.consent == 1
  ui.c_id:set_text("ID " .. hex2(st.beacon_id))
  ui.c_cons:set_text(yes and "OPT-IN" or "OPT-OUT")
  ui.c_cons:style({ text_color = yes and MARK_IN or MARK_OUT })
  ui.c_rate:set_text(string.format("%d ms  leds %s  radio %s  %dx%d",
    symbol_ms(), st.leds_on and "on" or "off",
    st.radio_on and (st.radio_ok and "on" or "FAIL") or "off",
    SCREEN_W, SCREEN_H))
end
local function notice(text, colour, ms, r, g, b)
  ui.c_ban:set_text(text)
  ui.c_ban:style({ text_color = colour })
  ui.c_ban:hidden(false)
  st.note_until = badge.sys.ms() + ms
  st.note_on = true
  if st.leds_on then
    badge.led.set_all(r, g, b)
    badge.led.show()
  end
end
local function show_beacon()
  st.screen = 2
  ui.cfg:hidden(true)
  ui.bcn:hidden(false)
  st.t0 = badge.sys.ms()
  st.last_slot = -1
end
local function show_config()
  st.screen = 1
  ui.bcn:hidden(true)
  ui.cfg:hidden(false)
end
local function radio_send(msg)
  if st.radio_on and st.radio_ok then badge.radio.send(msg) end
end
local function on_radio(mac, rssi, payload)
  if type(payload) ~= "string" or #payload < 6 then return end
  if payload:sub(1, 3) ~= RADIO_TAG then return end
  local kind = payload:sub(4, 4)
  local id = tonumber(payload:sub(5, 6), 16)
  if id == nil or id ~= st.beacon_id then return end
  if kind == "F" then
    notice("YOU WERE FILMED", 0xF87171, ALERT_MS, LED_LEVEL, 0, 0)
  elseif kind == "C" then
    local s = payload:sub(7, 7)
    if s == "1" or s == "0" then
      st.consent = (s == "1") and 1 or 0
      badge.store.set("consent", st.consent)
      build_frame()
      led_consent()
      refresh_config()
    end
  end
end
local function radio_start()
  st.radio_ok = badge.radio.enable() and true or false
  if st.radio_ok then badge.radio.on_recv(on_radio) end
  return st.radio_ok
end
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
function on_enter(root)
  st.consent = clamp(badge.store.get_int("consent", 0), 0, 1)
  st.timing = clamp(badge.store.get_int("timing", DEFAULT_TIMING), 1, #TIMING_MS)
  st.leds_on = badge.store.get_int("leds", 1) == 1
  st.beacon_id = derive_beacon_id()
  build_frame()
  ui.bg = badge.ui.box(root, badge.ui.screen_width, badge.ui.screen_height)
  ui.bg:set_pos(0, 0)
  ui.bg:style({ bg_color = 0x000000, radius = 0, border_width = 0, pad_all = 0 })
  ui.bcn = badge.ui.box(ui.bg, badge.ui.screen_width, badge.ui.screen_height)
  ui.bcn:set_pos(0, 0)
  ui.bcn:style({ bg_color = 0x000000, radius = 0, border_width = 0, pad_all = 0 })
  ui.frame = badge.ui.box(ui.bcn, SCREEN_W, SCREEN_H)
  ui.frame:set_pos(POS_X, POS_Y)
  ui.frame:style({ bg_color = WHITE, radius = 0, border_width = 0, pad_all = 0 })
  ui.blink = badge.ui.box(ui.bcn, IN_W, IN_H)
  ui.blink:set_pos(POS_X + BORDER, POS_Y + BORDER)
  ui.blink:style({ bg_color = 0x000000, radius = 0, border_width = 0, pad_all = 0 })
  ui.blink:bring_to_front()
  ui.bcn:hidden(true)
  ui.cfg = badge.ui.box(ui.bg, SCREEN_W, SCREEN_H)
  ui.cfg:set_pos(0, 0)
  ui.cfg:style({ bg_color = 0x101014, radius = 0, border_width = 0, pad_all = 0 })
  local who = badge.me.name()
  ui.c_name = badge.ui.label(ui.cfg, type(who) == "string" and who or "unprovisioned")
  ui.c_name:set_pos(12, 8)
  ui.c_name:style({ text_color = 0xE5E7EB, text_font = 24 })
  ui.c_id = badge.ui.label(ui.cfg, "")
  ui.c_id:set_pos(12, 44)
  ui.c_id:style({ text_color = WHITE, text_font = 24 })
  ui.c_cons = badge.ui.label(ui.cfg, "")
  ui.c_cons:set_pos(12, 80)
  ui.c_cons:style({ text_font = 24 })
  ui.c_rate = badge.ui.label(ui.cfg, "")
  ui.c_rate:set_pos(12, 116)
  ui.c_rate:style({ text_color = 0x9CA3AF, text_font = 14 })
  ui.c_keys = badge.ui.label(ui.cfg, "A opt  B rate  L led  R radio")
  ui.c_keys:set_pos(12, 146)
  ui.c_keys:style({ text_color = 0x6B7280, text_font = 14 })
  ui.c_go = badge.ui.label(ui.cfg, "START = BEACON")
  ui.c_go:set_pos(12, 168)
  ui.c_go:style({ text_color = 0xFFBD00, text_font = 24 })
  ui.c_ban = badge.ui.label(ui.cfg, "")
  ui.c_ban:set_pos(12, 206)
  ui.c_ban:style({ text_font = 14 })
  ui.c_ban:hidden(true)
  refresh_config()
  led_consent()
  st.t0 = badge.sys.ms()
  st.last_slot = -1
end
function on_tick()
  local now = badge.sys.ms()
  if st.screen == 2 then
    local slot = (now - st.t0) // symbol_ms()
    if slot ~= st.last_slot then
      st.last_slot = slot
      ui.blink:style({ bg_color = st.frame[(slot % SYMBOLS) + 1] })
    end
  end
  if st.note_on and now >= st.note_until then
    st.note_on = false
    ui.c_ban:hidden(true)
    led_consent()
  end
end
function on_button(button, kind)
  if kind ~= PRESSED then return end
  local now = badge.sys.ms()
  if st.screen == 2 then
    show_config()
    if now >= st.note_until then
      notice("BEACON STOPPED", 0xFFBD00, STOPPED_MS, LED_LEVEL, 26, 0)
    end
    return
  end
  if button == BUTTON.A then
    st.consent = (st.consent == 1) and 0 or 1
    badge.store.set("consent", st.consent)
    build_frame()
    led_consent()
    radio_send(RADIO_TAG .. "R" .. hex2(st.beacon_id) .. tostring(st.consent))
    refresh_config()
  elseif button == BUTTON.B then
    st.timing = (st.timing % #TIMING_MS) + 1
    badge.store.set("timing", st.timing)
    refresh_config()
  elseif button == BUTTON.LEFT then
    st.leds_on = not st.leds_on
    badge.store.set("leds", st.leds_on and 1 or 0)
    led_consent()
    refresh_config()
  elseif button == BUTTON.RIGHT then
    if st.radio_on then
      st.radio_on = false
      st.radio_ok = false
      badge.radio.disable()
    else
      st.radio_on = true
      radio_start()
    end
    refresh_config()
  elseif button == BUTTON.START then
    badge.store.set("consent", st.consent)
    badge.store.set("timing", st.timing)
    badge.store.set("leds", st.leds_on and 1 or 0)
    show_beacon()
  end
end
function on_exit()
  badge.led.clear()
  badge.led.show()
  if st.radio_on then badge.radio.disable() end
  badge.store.set("consent", st.consent)
  badge.store.set("timing", st.timing)
  badge.store.set("leds", st.leds_on and 1 or 0)
end
