--[==[badge-app
slug=cnsruler
name=Ruler
icon=RUL
api=2
heap_kb=64
wake_lock=1
version=0.1.0
author=Consentinel
]==]

-- Screen ruler. Static on purpose: edit the four numbers, push, look.
--
-- RIGHT looks like: a RED rectangle touching all four physical edges, a
-- WHITE square in each of its corners, amber text inside.
--
-- WRONG reads like this:
--   Fewer than four white corners -> that corner is off the panel.
--   Red cut off on a side         -> PANEL_* too big, or OX/OY too negative.
--   GREEN ring sits 10 px inside the red, BLUE 20 px inside. Red gone on the
--   right but green whole means you are over by 10 to 20 -- that is the
--   ruler. Shrink, re-push.
--   Nothing at all but black      -> root clipped the whole box: OX/OY are
--                                    more negative than the real padding.
--
-- Whatever numbers make it fit ARE the panel. Copy them into
-- consentinel-beacon.lua as PANEL_X/PANEL_Y/PANEL_W/PANEL_H.

local OX, OY = 0, 0              -- <-- ORIGIN. Cancels root's padding.
local PANEL_W, PANEL_H = 320, 240    -- <-- SIZE. Guess high, shrink to fit.

local THICK = 3
local BG = 0x000000

local function box(parent, w, h, x, y, colour)
  local b = badge.ui.box(parent, w, h)
  b:set_pos(x, y)
  b:style({ bg_color = colour, radius = 0, border_width = 0, pad_all = 0 })
  return b
end

-- Outline = solid box with a black box on top of it, inset by THICK. No
-- border_width, no pad_all: nothing here can disagree about inset semantics.
local function ring(parent, x, y, w, h, colour)
  if w <= 2 * THICK or h <= 2 * THICK then return end
  box(parent, w, h, x, y, colour)
  box(parent, w - 2 * THICK, h - 2 * THICK, x + THICK, y + THICK, BG)
end

function on_enter(root)
  -- The one negative offset, and it is on the OUTERMOST box. Children are
  -- clipped to their parent, so everything below stays at 0,0 or greater.
  local bg = box(root, PANEL_W, PANEL_H, OX, OY, BG)

  ring(bg, 0, 0, PANEL_W, PANEL_H, 0xFF0000)
  ring(bg, 10, 10, PANEL_W - 20, PANEL_H - 20, 0x00FF00)
  ring(bg, 20, 20, PANEL_W - 40, PANEL_H - 40, 0x0000FF)

  -- Corner squares. COUNT THEM. Four means the rectangle fits the panel.
  local S = 12
  for i = 0, 3 do
    box(bg, S, S, (i % 2 == 0) and 0 or PANEL_W - S,
                  (i < 2) and 0 or PANEL_H - S, 0xFFFFFF)
  end

  local l = badge.ui.label(bg, string.format("%dx%d @ %d,%d",
                                             PANEL_W, PANEL_H, OX, OY))
  l:set_pos(32, 40)
  l:style({ text_color = 0xFFBD00, text_font = 24 })

  local k = badge.ui.label(bg, "red edge / green -10 / blue -20")
  k:set_pos(32, 76)
  k:style({ text_color = 0x9CA3AF, text_font = 14 })
end
