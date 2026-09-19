# Consentinel — badge layer

Owner: Maaz. Consumers: capture app (Hashim), registry/service (Nehad).

The badge is the **consent beacon**. It broadcasts its identity as light so the
capture app can find it in frame and bind the nearest face to an on-chain
consent record, and it raises a visible alarm when its wearer is filmed
without consent.

---

## 1. Hardware reality (read this before planning anything)

Taken from the official HAL at <https://badge.hackthenorth.com/custom-flash>
and the Lua API guide at <https://badge.hackthenorth.com/ide/>.

| | |
|---|---|
| MCU | ESP32-C3-MINI-1-N4 (RISC-V, 4 MB flash, USB-Serial-JTAG) |
| Display | ST7789, 320×240, RGB565, SPI |
| Buttons | 8 via 74HC165 shift register + dedicated Start |
| Motion | SC7A20 accelerometer, I²C 0x19 |
| NFC | MFRC522, I²C 0x26 — **reader only**, no tag writing from Lua |
| LEDs | 6× WS2812B-2020 around the board edge |
| Power | 2×AA → MT3608 boost → XC6220 LDO |

**Three corrections to the original build spec:**

1. **There is no buzzer, no haptic motor and no speaker.** The Lua guide states
   there is no exposed audio API. Phase 4's "badge buzzes" is impossible.
   Replacement: **red LED breathing alarm + on-screen `YOU WERE FILMED`
   banner** on the badge, with the **ElevenLabs voice played from the capture
   laptop**. §11.3's acceptance check still passes and it is more audible in a
   loud room.
2. **There is no Wi-Fi, HTTP or general BLE from Lua.** The only radio is
   `badge.radio`: a restricted broadcast channel, `LUA1`-prefixed, **44-byte
   payloads**. `USE_MQTT` / Wi-Fi notification transport is off the table
   without a custom flash. See §5 for the downlink problem.
3. **No PlatformIO firmware is needed or wanted.** Everything here is a
   sandboxed Lua app pushed over USB WebSerial. Re-flashing voids a badge the
   organizers say they may not be able to replace. Custom flash is a non-goal.

Other limits that shaped the design: 48 KB Lua heap (96 opt-in), 512 widgets,
`on_tick` nominal **20 ms but not guaranteed**, 250 ms tick failure cutoff,
no `os`/`io`/`coroutine`/`pcall`. Six LEDs at full white can brown out the
board on AA power, so the beacon drives them at level 90.

### Gotcha: this badge's Lua has 32-bit integers

Confirmed on-device, and not mentioned in the official guide. Any **decimal**
literal above `2147483647` is silently parsed as a *float*, and floats then
fail every bitwise operator:

```
on_enter: main.lua:267: number (local 'h') has no integer representation
```

Write large constants in **hex** — `0x811C9DC5` instead of `2166136261`. A hex
literal wraps to the same bit pattern as a genuine integer. Integer overflow
wraps two's-complement (which is what FNV-1a wants anyway) and `>>` is a
*logical* shift, so hashing still works on the resulting negative values.

---

## 2. Installing the app

1. Open <https://badge.hackthenorth.com/ide/> in Chrome.
2. **Import app** → paste `firmware/consentinel-beacon.lua`. The `--[==[badge-app`
   header is split off into `manifest.cfg`; the rest becomes `main.lua`.
3. Plug the badge in over USB-C → **Connect** → **Push**.
4. Open **Consentinel** from the badge launcher.

After changing a manifest key (`api`, `heap_kb`, `wake_lock`, `confirm_home`)
on an already-installed slug you must **Reboot**, not just Push. Ordinary code
edits only need Push + reopening the app.

`wake_lock=1` keeps the badge awake while the beacon runs. `confirm_home=1`
means a stray HOME press asks for confirmation instead of killing the beacon
mid-demo — ticks pause during that prompt, which safely reads as "no beacon"
and therefore "blur".

### Controls

| Key | Action |
|---|---|
| A | toggle the local consent mirror (and emit a `CNSR` request if radio is on) |
| B | cycle symbol period: 80 / 100 / 120 / 150 ms |
| UP / DOWN | nudge the beacon id ±1 (for testing several ids on one badge) |
| LEFT | LED mirror on/off |
| RIGHT | radio on/off (**off by default** — BLE costs RAM and must not risk the hero path) |
| START | switch optical mode P ↔ S |

---

## 3. Optical protocol — the decoder contract

Constants live in [`shared/beacon.ts`](../shared/beacon.ts) and are mirrored in
the Lua source. **Change both in the same commit.**

The patch sits at (8, 6), 304×132, with an **always-lit 5 px white border**.
That border is the localization anchor: find the bright quad, rectify it,
sample the cells inside. It also gives you the beacon's image position for the
nearest-face-above association in spec §7.

### MODE P — parallel (default)

The patch interior is a 3×2 grid of 98×61 cells:

```
[1 clock][2 frame][3 d3]
[4 d2   ][5 d1   ][6 d0]
```

- **clock** flips every symbol → a 2×symbol-period square wave. Recover the
  symbol boundary from its edges.
- **frame** is lit only on symbol 0 of each frame.
- **d3..d0** carry 4 bits per symbol, most significant lane first.

Payload is 12 bits: `id(8) << 4 | crc4(id)`, most significant nibble first,
so a frame is **3 symbols = 300 ms** at the default rate. `decodeFrame()` in
`shared/beacon.ts` does the assembly and CRC check for you.

CRC-4 uses polynomial x⁴+x+1 (0b10011). A CRC failure means **blur** — never
guess.

### MODE S — serial (fallback)

The whole patch flashes one Manchester stream; the decoder is just "track one
blob's brightness". Frame layout:

```
SYNC: 3 lit halves, 3 dark halves      (a run of 3 is impossible in Manchester)
START BIT: 1
DATA: 8 id bits, MSB first             (1 → lit,dark   0 → dark,lit)
CRC:  4 bits
STOP: 1 dark half
```

The start bit and stop half pin both sync runs to **exactly** three, so
"3 lit then 3 dark" is unambiguous. 33 halves → ~3.3 s per frame at 100 ms.

Use MODE S to get a decoder working in twenty minutes, then move to MODE P for
the 10× latency improvement. The app switches live with START.

### Timing notes for the decoder

The limiting factor is **tick jitter, not camera FPS**: the badge can only
repaint on a ~20 ms tick that is explicitly not guaranteed on time. That is why
the default symbol period is 100 ms rather than something faster. Recover the
clock from the clock lane rather than assuming a fixed period, and treat any
symbol you cannot confidently sample as a decode failure (→ blur).

---

## 4. Radio protocol

All payloads ≤ 44 bytes, tagged `CNS`, `<id>` = two uppercase hex digits.

| Message | Direction | Meaning |
|---|---|---|
| `CNSF<id>` | service → badge | film event; badge raises the red alarm for 6 s |
| `CNSC<id><0\|1>` | service → badge | push the chain consent state to the badge mirror |
| `CNSR<id><0\|1>` | badge → service | consent-change **request**; unsigned |

`CNSR` is deliberately a request, not an update. The badge holds no keypair and
cannot sign — the registry client signs and submits. Say this out loud if a
judge asks whether the badge can forge consent.

---

## 5. Open problem: the laptop → badge downlink

The badge can *receive* on `badge.radio`, but only frames carrying the
firmware's `LUA1` prefix on its restricted channel. A laptop cannot trivially
emit those: Windows won't advertise custom BLE payloads at all, and macOS is
locked down too.

Three ways out, in order of preference:

1. **A spare ESP32 dev board from the hardware lab** as the downlink bridge:
   laptop → USB serial → ESP32 → BLE `LUA1` frame → badge. Sniff one
   `badge.radio.send()` from a badge first to capture the exact advertising
   layout, then replay it. **This is the thing to go solve first** — everything
   else in my lane is already unblocked.
2. **A Linux box with BlueZ**, which can craft extended advertising directly.
3. **Cut the downlink.** The hero path survives it: the beacon, the blur and
   the on-chain revoke→blur-flip all work uplink-free. Only the badge-side
   alarm in Phase 4 needs it, and the ElevenLabs alert plays from the laptop
   regardless. Radio is off by default in the app for exactly this reason.

---

## 6. Demo risks specific to the badge

| Risk | Mitigation |
|---|---|
| Badge rotates on the lanyard and the screen faces away | Controlled demo; wearers face the camera. Uncertain → blur, per `DEFAULT_CONSENT`. |
| Screen washes out under stage lighting | White-on-black patch at full contrast; B cycles the symbol rate if the camera struggles. |
| BLE fails to start ("Radio wouldn't start" = RAM) | Radio is off by default; reboot the badge and re-enable with RIGHT. |
| Battery sag over a 36 h event | LEDs capped at level 90, never all-white; carry spare AAs. |
| Stray HOME press kills the beacon | `confirm_home=1`. |
