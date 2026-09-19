--[==[badge-app
slug=consentinel
name=Consentinel
icon=CNS
api=2
heap_kb=96
wake_lock=1
confirm_home=1
version=0.1.0
author=Consentinel
]==]

-- Consentinel consent beacon (HTN 2026 hacker badge).
--
-- The badge broadcasts its identity optically so a capture app can locate it
-- in a video frame and tie the nearest face to an on-chain consent record.
-- The beacon carries an IDENTIFIER ONLY -- never a consent state. Consent is
-- owner-signed on Solana; a spoofed beacon can mislabel a blob but can never
-- flip anyone's consent.
--
-- Two optical modes, switchable live with START:
--   MODE P (parallel, default) -- the screen patch is a 3x2 grid of cells:
--       [clock][frame][d3]
--       [ d2  ][ d1  ][d0]
--     Four data lanes carry 4 bits per symbol; 12 bits (8-bit id + CRC-4)
--     take 3 symbols, so a whole frame is ~0.3 s.
--   MODE S (serial) -- the whole patch flashes one Manchester-coded stream.
--     Dumb-simple to decode (track one blob's brightness), ~3.3 s per frame.
--
-- The always-on white border around the patch is the localization anchor:
-- find the bright quad, rectify it, sample the cells inside.
--
-- See firmware/README.md for the wire format and the decoder contract.

local BUTTON = badge.input.BUTTON
local PRESSED = badge.input.KIND.PRESSED

-- ---------------------------------------------------------------- geometry

local SCREEN_W = badge.ui.screen_width
local SCREEN_H = badge.ui.screen_height

local PATCH_X, PATCH_Y = 8, 6
local PATCH_W, PATCH_H = 304, 132
local BORDER = 5
local COLS, ROWS = 3, 2
local CELL_W = (PATCH_W - 2 * BORDER) // COLS
local CELL_H = (PATCH_H - 2 * BORDER) // ROWS

local LIT = 0xffffff
local DARK = 0x000000

-- Cell roles, in reading order.
local CLOCK_CELL = 1
local FRAME_CELL = 2
local DATA_CELLS = { 3, 4, 5, 6 } -- most significant lane first

-- ------------------------------------------------------------ wire format

local ID_BITS = 8
local CRC_BITS = 4
local PAYLOAD_BITS = ID_BITS + CRC_BITS
local LANES = #DATA_CELLS
local SYMBOLS = PAYLOAD_BITS // LANES -- 3

local SYNC_RUN = 3 -- Manchester violation: a run of 3 is impossible in data

local TIMING_MS = { 80, 100, 120, 150 }
local DEFAULT_TIMING = 2 -- index into TIMING_MS -> 100 ms

local LED_LEVEL = 90 -- modest: six LEDs at full white can brown out on AA
local ALERT_MS = 6000

local RADIO_TAG = "CNS"

-- ------------------------------------------------------------------ state

local st = {
  beacon_id = 0,
  consent = 1, -- local MIRROR of the chain record, not the source of truth
  mode_parallel = true,
  timing = DEFAULT_TIMING,
  leds_on = true,
  radio_on = false,
  radio_ok = false,
  t0 = 0,
  last_slot = -1,
  last_led = -1,
  alert_until = 0,
  alert_shown = false,
  frame = nil, -- MODE S half-symbol table
  frame_len = 0,
}

local ui = { cells = {} }

-- ------------------------------------------------------------------ utils

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

-- CRC-4, polynomial x^4 + x + 1 (0b10011). Must match shared/beacon.ts.
local function crc4(value, nbits)
  local reg = 0
  for i = nbits - 1, 0, -1 do
    local bit = (value >> i) & 1
    local top = (reg >> 3) & 1
    reg = ((reg << 1) | bit) & 0xF
    if top == 1 then reg = reg ~ 0x3 end
  end
  return reg & 0xF
end

local function payload_of(id)
  return ((id & 0xFF) << CRC_BITS) | crc4(id & 0xFF, ID_BITS)
end

local function symbol_ms()
  return TIMING_MS[st.timing]
end

-- MODE S frame: SYNC_ON x3, SYNC_OFF x3, start bit (1), id, crc, stop half (0).
-- The leading start bit and trailing stop half pin both sync runs to exactly
-- three, so "3 lit then 3 dark" is an unambiguous frame marker.
local function build_serial_frame(id)
  local halves, n = {}, 0
  local function put(v)
    n = n + 1
    halves[n] = v
  end
  local function put_bit(b)
    -- Manchester: 1 -> lit,dark   0 -> dark,lit
    if b == 1 then put(1) put(0) else put(0) put(1) end
  end

  for _ = 1, SYNC_RUN do put(1) end
  for _ = 1, SYNC_RUN do put(0) end
  put_bit(1) -- start bit
  for i = ID_BITS - 1, 0, -1 do put_bit((id >> i) & 1) end
  local c = crc4(id, ID_BITS)
  for i = CRC_BITS - 1, 0, -1 do put_bit((c >> i) & 1) end
  put(0) -- stop half

  st.frame = halves
  st.frame_len = n
end

-- --------------------------------------------------------------------- ui

local function set_cell(idx, lit)
  local w = ui.cells[idx]
  if w then w:style({ bg_color = lit and LIT or DARK }) end
end

local function show_cells(visible)
  for i = 1, COLS * ROWS do
    local w = ui.cells[i]
    if w then w:hidden(not visible) end
  end
end

local function status_text()
  local mode = st.mode_parallel and "P" or "S"
  local radio = st.radio_on and (st.radio_ok and "RADIO ON" or "RADIO FAIL") or "radio off"
  return string.format("mode %s  %d ms  leds %s  %s",
    mode, symbol_ms(), st.leds_on and "on" or "off", radio)
end

local function refresh_status()
  if ui.identity then
    ui.identity:set_text(string.format("ID %s   %s",
      hex2(st.beacon_id), st.consent == 1 and "OPT-IN" or "OPT-OUT"))
    ui.identity:style({ text_color = st.consent == 1 and 0x4ade80 or 0xf87171 })
  end
  if ui.status then ui.status:set_text(status_text()) end
end

-- ------------------------------------------------------------------ leds

local function led_beacon(lit)
  if not st.leds_on then return end
  local v = lit and LED_LEVEL or 0
  badge.led.set_all(v, v, v)
  badge.led.show()
end

local function led_alert(now)
  -- Breathing red while an alert is live. Beacon LEDs are suspended; the
  -- screen beacon keeps transmitting, so identification never drops.
  local phase = (now // 120) % 10
  local level = 60 + 20 * (phase < 5 and phase or (9 - phase))
  level = clamp(level // 1, 0, 255)
  badge.led.set_all(level, 0, 0)
  badge.led.show()
end

-- --------------------------------------------------------------- beacon tx

local function render_parallel(slot)
  local sym = slot % SYMBOLS
  local payload = payload_of(st.beacon_id)
  -- Most significant nibble first.
  local shift = (SYMBOLS - 1 - sym) * LANES
  local nibble = (payload >> shift) & ((1 << LANES) - 1)

  set_cell(CLOCK_CELL, (slot % 2) == 0)
  set_cell(FRAME_CELL, sym == 0)
  for lane = 1, LANES do
    local bit = (nibble >> (LANES - lane)) & 1
    set_cell(DATA_CELLS[lane], bit == 1)
  end
  return (slot % 2) == 0
end

local function render_serial(slot)
  local idx = (slot % st.frame_len) + 1
  local lit = st.frame[idx] == 1
  if ui.patch then ui.patch:style({ bg_color = lit and LIT or DARK }) end
  return lit
end

-- ------------------------------------------------------------------ radio

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
    -- Film event: this badge was captured while not consenting.
    st.alert_until = badge.sys.ms() + ALERT_MS
  elseif kind == "C" then
    -- Consent mirror pushed down from the chain-backed registry.
    local s = payload:sub(7, 7)
    if s == "1" or s == "0" then
      st.consent = (s == "1") and 1 or 0
      badge.store.set("consent", st.consent)
      refresh_status()
    end
  end
end

local function radio_start()
  st.radio_ok = badge.radio.enable() and true or false
  if st.radio_ok then badge.radio.on_recv(on_radio) end
  return st.radio_ok
end

-- -------------------------------------------------------------- lifecycle

local function derive_beacon_id()
  local override = badge.store.get_int("id_ovr", -1)
  if override >= 0 and override <= 255 then return override end

  local bid = badge.me.badge_id()
  if type(bid) ~= "string" or #bid == 0 then return 0 end

  -- FNV-1a over the provisioned badge id, folded to 8 bits. The registry
  -- derives the same value, so the PDA seed and the beacon agree.
  --
  -- The offset basis MUST be written in hex. This badge's Lua has 32-bit
  -- integers, so the decimal literal 2166136261 exceeds INT_MAX and is
  -- parsed as a float, which then fails every bitwise operator with
  -- "number has no integer representation". The hex form wraps to the same
  -- bit pattern as a genuine integer. Integer overflow in the multiply
  -- wraps two's-complement, which is exactly what FNV-1a wants, and `>>`
  -- is a logical shift, so the fold works on the negative value too.
  local h = 0x811C9DC5
  for i = 1, #bid do
    h = (h ~ bid:byte(i)) & 0xFFFFFFFF
    h = (h * 16777619) & 0xFFFFFFFF
  end
  return ((h >> 24) ~ (h >> 16) ~ (h >> 8) ~ h) & 0xFF
end

function on_enter(root)
  st.consent = badge.store.get_int("consent", 1)
  st.timing = clamp(badge.store.get_int("timing", DEFAULT_TIMING), 1, #TIMING_MS)
  st.mode_parallel = badge.store.get_int("mode_p", 1) == 1
  st.leds_on = badge.store.get_int("leds", 1) == 1
  st.beacon_id = derive_beacon_id()
  build_serial_frame(st.beacon_id)

  local bg = badge.ui.box(root, SCREEN_W, SCREEN_H)
  bg:set_pos(0, 0)
  bg:style({ bg_color = 0x0b0b0f, radius = 0, border_width = 0, pad_all = 0 })

  ui.patch = badge.ui.box(bg, PATCH_W, PATCH_H)
  ui.patch:set_pos(PATCH_X, PATCH_Y)
  ui.patch:style({ bg_color = DARK, radius = 0, pad_all = 0 })
  ui.patch:set_border(LIT, BORDER)

  for r = 0, ROWS - 1 do
    for c = 0, COLS - 1 do
      local cell = badge.ui.box(ui.patch, CELL_W, CELL_H)
      cell:set_pos(c * CELL_W, r * CELL_H)
      cell:style({ bg_color = DARK, radius = 0, border_width = 0, pad_all = 0 })
      ui.cells[r * COLS + c + 1] = cell
    end
  end
  show_cells(st.mode_parallel)

  local who = badge.me.name()
  ui.who = badge.ui.label(bg, type(who) == "string" and who or "unprovisioned")
  ui.who:set_pos(10, 146)
  ui.who:style({ text_color = 0x9ca3af, text_font = 14 })

  ui.identity = badge.ui.label(bg, "")
  ui.identity:set_pos(10, 166)
  ui.identity:style({ text_font = 24 })

  ui.status = badge.ui.label(bg, "")
  ui.status:set_pos(10, 200)
  ui.status:style({ text_color = 0x6b7280, text_font = 14 })

  ui.keys = badge.ui.label(bg, "A:cons B:rate UD:id L:led R:radio S:mode")
  ui.keys:set_pos(10, 220)
  ui.keys:style({ text_color = 0x4b5563, text_font = 14 })

  ui.alert = badge.ui.box(bg, 300, 60)
  ui.alert:set_pos(10, 172)
  ui.alert:style({ bg_color = 0x7f1d1d, radius = 6, pad_all = 0 })
  ui.alert:set_border(0xf87171, 2)
  ui.alert:hidden(true)

  ui.alert_text = badge.ui.label(ui.alert, "YOU WERE FILMED")
  ui.alert_text:align("center", 0, 0)
  ui.alert_text:style({ text_color = 0xfecaca, text_font = 22 })

  refresh_status()

  st.t0 = badge.sys.ms()
  st.last_slot = -1
  st.last_led = -1
end

function on_tick()
  local now = badge.sys.ms()
  local slot = (now - st.t0) // symbol_ms()

  if slot ~= st.last_slot then
    st.last_slot = slot
    local lit
    if st.mode_parallel then
      lit = render_parallel(slot)
    else
      lit = render_serial(slot)
    end

    if now >= st.alert_until and st.leds_on then
      local v = lit and 1 or 0
      if v ~= st.last_led then
        st.last_led = v
        led_beacon(lit)
      end
    end
  end

  local alerting = now < st.alert_until
  if alerting then
    led_alert(now)
    st.last_led = -1
    if not st.alert_shown then
      st.alert_shown = true
      ui.alert:hidden(false)
      ui.alert:bring_to_front()
    end
  elseif st.alert_shown then
    st.alert_shown = false
    ui.alert:hidden(true)
    if not st.leds_on then
      badge.led.clear()
      badge.led.show()
    end
  end
end

function on_button(button, kind)
  if kind ~= PRESSED then return end

  if button == BUTTON.A then
    st.consent = (st.consent == 1) and 0 or 1
    badge.store.set("consent", st.consent)
    -- The badge cannot sign; this is a REQUEST the registry client signs.
    radio_send(RADIO_TAG .. "R" .. hex2(st.beacon_id) .. tostring(st.consent))
    refresh_status()

  elseif button == BUTTON.B then
    st.timing = (st.timing % #TIMING_MS) + 1
    badge.store.set("timing", st.timing)
    st.t0 = badge.sys.ms()
    st.last_slot = -1
    refresh_status()

  elseif button == BUTTON.UP or button == BUTTON.DOWN then
    local delta = (button == BUTTON.UP) and 1 or -1
    st.beacon_id = (st.beacon_id + delta) & 0xFF
    badge.store.set("id_ovr", st.beacon_id)
    build_serial_frame(st.beacon_id)
    st.last_slot = -1
    refresh_status()

  elseif button == BUTTON.LEFT then
    st.leds_on = not st.leds_on
    badge.store.set("leds", st.leds_on and 1 or 0)
    if not st.leds_on then
      badge.led.clear()
      badge.led.show()
    end
    st.last_led = -1
    refresh_status()

  elseif button == BUTTON.RIGHT then
    if st.radio_on then
      st.radio_on = false
      st.radio_ok = false
      badge.radio.disable()
    else
      st.radio_on = true
      radio_start()
    end
    refresh_status()

  elseif button == BUTTON.START then
    st.mode_parallel = not st.mode_parallel
    badge.store.set("mode_p", st.mode_parallel and 1 or 0)
    show_cells(st.mode_parallel)
    if st.mode_parallel then
      ui.patch:style({ bg_color = DARK })
    end
    st.t0 = badge.sys.ms()
    st.last_slot = -1
    refresh_status()
  end
end

function on_exit()
  badge.led.clear()
  badge.led.show()
  if st.radio_on then badge.radio.disable() end
  badge.store.set("consent", st.consent)
  badge.store.set("timing", st.timing)
  badge.store.set("mode_p", st.mode_parallel and 1 or 0)
  badge.store.set("leds", st.leds_on and 1 or 0)
end
