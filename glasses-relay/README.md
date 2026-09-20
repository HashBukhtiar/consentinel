# glasses-relay

Meta Ray-Ban glasses → iPhone → capture app.

The glasses have no path to a laptop. The [Meta Wearables Device Access
Toolkit](https://github.com/facebook/meta-wearables-dat-ios) delivers camera
frames over Bluetooth to an **iPhone app**, and nowhere else. This is that app,
kept to the minimum: it takes frames from the SDK, JPEG-encodes them, and serves
them on a WebSocket. The capture app connects and treats the result like a
webcam.

```
glasses ──BT──▶ iPhone (this app) ──WebSocket, JPEG──▶ capture-app "Glasses" ──▶ existing pipeline
```

Two Swift files:

| file | what |
|---|---|
| `ConsentinelRelay/ConsentinelRelayApp.swift` | SDK session + stream, and the one-screen UI that shows the address to type into the capture app |
| `ConsentinelRelay/FrameServer.swift` | WebSocket broadcast over Network.framework, plus the phone's IP lookup |
| `ConsentinelRelay/Info.plist` | the keys the SDK requires — URL scheme, `MWDAT` block, Bluetooth + local-network entitlements |

## Setup

Steps 1–3 are yours — they need your Apple ID, your Meta account and a physical
iPhone. Bluetooth doesn't work in the Simulator, so the glasses need real
hardware.

**1. Glasses.** Update the Meta AI app, pair the glasses, and turn on
**Developer Mode** in its settings. Developer Mode switches itself off after a
glasses firmware update, so don't update right before the demo.

**2. Meta developer account.** Register an app in the [Wearables Developer
Center](https://developers.meta.com/wearables/) to get a `MetaAppID` and
`ClientToken`. Developer Mode skips attestation, so the demo works with these
left empty — the plist references them as build settings (`META_APP_ID`,
`CLIENT_TOKEN`) so you can fill them in later without editing code. The FAQ says
full capabilities need residence in a supported country; check that Canada
qualifies before relying on this path.

**3. Xcode project.** There's no `.xcodeproj` here — Meta's SDK and sample are
under their Developer Terms rather than an open-source licence, so nothing of
theirs is vendored into this repo. Make the project from Xcode's own template:

1. **File → New → Project → iOS → App**. Name it `ConsentinelRelay`, interface
   SwiftUI, language Swift. Save it into this directory.
2. Delete the generated `ContentView.swift` and `ConsentinelRelayApp.swift`, then
   drag in the two `.swift` files from `ConsentinelRelay/`.
3. **File → Add Package Dependencies…** → `https://github.com/facebook/meta-wearables-dat-ios`
   → version **0.9.0**. Add `MWDATCore` and `MWDATCamera` to the app target.
4. Use this directory's `Info.plist`: set **Build Settings → Packaging →
   Info.plist File** to `ConsentinelRelay/Info.plist` and **Generate Info.plist
   File** to `No`.
5. **Signing & Capabilities** → pick your team. Set the deployment target to
   **iOS 17.2** or later (the SDK's floor).
6. Run on the iPhone — not the Simulator.

## Using it

1. Put the laptop on the **iPhone's Personal Hotspot**. Venue Wi-Fi usually
   blocks device-to-device traffic, and the hotspot also gives the laptop
   internet for Solana devnet.
2. Launch the relay, tap **Start**. It opens Meta AI to link, asks the glasses
   for camera permission, then streams. The phone shows a live preview and the
   address (`ws://10.x.x.x:8080`).
3. In the capture app, type that address into the box next to **Glasses** and
   click it. It's remembered, so you type it once.

## Tuning for beacon decode

`RelayConfig` at the top of `ConsentinelRelayApp.swift`:

```swift
static let resolution: StreamingResolution = .high   // 720x1280, the SDK's max
static let frameRate: UInt = 15                      // 2, 7, 15, 24 or 30
static let jpegQuality: CGFloat = 0.7
```

720×1280 is the ceiling, and the SDK silently drops resolution then frame rate
when Bluetooth bandwidth gets tight — so these are requests, not guarantees.
Lower frame rates compress less per frame, which is what the beacon cares about:
the static key decodes off a single clean frame, so pixels beat frames. If the
badge won't decode at range, drop `frameRate` to 7 before touching anything else.

**Untested:** whether the static key decodes from a chest-worn badge at 720p over
the Bluetooth link. The smallest-decodable-patch numbers in `capture-app` were
measured on the previous pattern and against a webcam. Budget time to check this
on real hardware — it's the one part of this path that could still fail.

## Without glasses

`MWDATMockDevice` (same package, `#if DEBUG`) plays a video file as a fake device
feed, which exercises the relay and the whole capture pipeline with no hardware.
See the SDK's `mockdevice-testing` skill.

Meta ships Claude Code skills for this SDK in the repo — `install-skills.sh`
adds camera-streaming, session-lifecycle, debugging and mock-device guides.

## Troubleshooting

| symptom | cause |
|---|---|
| "Can't open port 8080" | another app has it; change `RelayConfig.port` |
| capture app can't reach the relay | laptop isn't on the hotspot, or iOS local-network permission was denied — Settings → Consentinel Relay |
| "Waiting for the glasses to connect…" forever | glasses asleep, or Developer Mode switched off by a firmware update |
| stream pauses | hinges closed, or the glasses are thermally throttled |
