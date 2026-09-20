# Glasses relay: status

> **Update:** the Info.plist fix below worked. The relay app now reaches `streaming`
> and shows the live glasses feed on the phone. Not yet verified: the laptop
> connecting to the relay, and beacon decode from the glasses feed. The sections
> below record how the stream was unblocked.

Snapshot of where the Meta glasses path stands. Written after the first on-device
run. The browser half works; the iPhone half runs but the glasses stream never
starts.

## Goal

Get Meta Ray-Ban glasses video into the capture app as a video source.

```
glasses ──(?)──▶ iPhone relay app (Meta DAT SDK 0.9.0) ──WebSocket, JPEG──▶ capture-app "Glasses" source ──▶ pipeline
```

The glasses only talk to a phone, so the phone runs a small relay app that
re-serves the frames to the laptop.

## What exists

| piece | where | state |
|---|---|---|
| Capture-app source `startGlasses(url)` | `capture-app/src/sources/videoSource.ts` | **Works.** Tested against a fake relay: frames update, Stop closes the socket. |
| Glasses address box + button | `capture-app/src/ui/App.tsx`, `styles.css` | **Works.** Address is remembered in localStorage. |
| Relay app source | `glasses-relay/ConsentinelRelay-xcode/ConsentinelRelay-xcode/` | **Compiles and runs on an iPhone.** Originals also in `glasses-relay/ConsentinelRelay/` (identical copies). |
| `Info.plist` | `glasses-relay/ConsentinelRelay/Info.plist` | In use. Xcode reads it via `INFOPLIST_FILE = ../ConsentinelRelay/Info.plist`. |
| Xcode project | `glasses-relay/ConsentinelRelay-xcode/*.xcodeproj` | Set up: iPhone only, iOS 17.2+, SDK 0.9.0 (exact), `MWDATCore` + `MWDATCamera`, signed with a Personal Team. |
| Setup guide | `glasses-relay/README.md` | Partly stale, see "Doc fixes" below. |

The relay app:
- links the glasses through Meta AI, checks/requests camera permission, waits for
  the SDK to name an eligible device, then starts a session and a camera stream;
- serves JPEG frames over WebSocket on port 8080 (Network.framework, no dependency);
- shows a live preview, the `ws://` address, and one line of raw SDK state;
- has live Resolution and FPS menus (restart the camera on change), a watchdog that
  restarts a frozen stream after 4 s, and keeps the screen awake while relaying.

## What works on the device

- App installs and launches on the phone (Maaz's iPhone 13 Pro Max, iOS 26.6.2).
- Registration and camera permission go through Meta AI.
- The SDK finds the glasses and creates a session: `session started`.
- The SDK reports `link connected` and `Compatible` for the glasses.
- The frame server starts (`listening on 8080`) and the app shows the phone's
  address, e.g. `ws://10.36.1.149:8080`.

## The problem

**The camera stream never starts.** It sits in `waitingForDevice` (and at first
`stopped`) with no frames. The phone's state line after the app had
retried on a second setting:

```
session started · stream waitingForDevice · link connected · Compatible
· cfg raw/medium/15 · ERR deviceNotConnected("<glasses id>")
```

The SDK says the link is connected but the stream fails with `deviceNotConnected`.
So the glasses are reachable, and whatever the video travels over is not coming up.

Bugs that were found and fixed along the way (so they don't get re-diagnosed):
1. `noEligibleDevice`: the relay created a session before the device selector had
   found the glasses. Now it waits up to 20 s.
2. Permission prompt looping: it re-requested camera permission on every Start.
   Now it checks first.
3. `sessionAlreadyExists` on a second Start: the old session was never retired and
   Stop was hidden until frames flowed. Now Stop/reset is always shown and Start
   waits for the old session to reach `stopped`.
4. The stream error was hidden: the `.stopped` message overwrote it. Now kept as
   `ERR …` on the state line.

## Leading cause: missing Info.plist keys (fix applied, needs a device run)

Meta's `AGENTS.md` and the SDK binary itself require keys the relay's Info.plist
did not have. The SDK validates them and prints its own messages, including
`UISupportedExternalAccessoryProtocols must contain 'com.meta.ar.wearable'`,
`UIBackgroundModes must contain 'external-accessory'` and `Unable to generate a
session for this accessory. Double check your Info.plist and ensure it includes the
right EASession protocols.` The SDK links ExternalAccessory and discovers the glasses
as an EAAccessory. That fits the symptoms: BLE gives `link connected · Compatible`,
but the accessory channel that carries the camera feed can't open.

Applied to `glasses-relay/ConsentinelRelay/Info.plist` (verified present in the
built app's final Info.plist; not yet run on the glasses):
- `UISupportedExternalAccessoryProtocols` = `com.meta.ar.wearable`
- `UIBackgroundModes` now also has `external-accessory`
- `LSApplicationQueriesSchemes` = `fb-viewapp`
- `MWDAT`: `MetaAppID` = `0`, and `ClientToken` / `TeamID` removed. The SDK warns
  that a partially filled attestation set fails ("All values must be present"), and
  the old plist had an empty `ClientToken` beside a filled `TeamID`.

Correction: I built the first plist from Meta's sample app and missed these keys,
which the sample's own docs list. That was my error.

## Earlier hypothesis: Wi-Fi entitlements (demoted, still possible)

This was the leading guess before the Info.plist gap was found. Treat it as the
fallback if the stream still fails after the plist fix.

Evidence:
- The SDK changelog says version 0.8.0 added a **Wi-Fi transport**, and strings in
  the SDK binary mention SoftAP and Wi-Fi Aware setup. So video probably does not
  travel over Bluetooth alone. (Earlier notes in this repo said Bluetooth only;
  that is out of date.)
- Meta's `CameraAccess` sample enables the entitlements
  `com.apple.developer.networking.HotspotConfiguration`,
  `com.apple.developer.networking.wifi-info` and keychain access groups. This
  project has none of them.
- The device log has `NEHotspotConfigurationHelper failed to communicate to helper
  server` and `Failed to send a 9 message to nehelper`, which is what iOS logs when
  an app tries to join a Wi-Fi network without the Hotspot Configuration entitlement.
- In Xcode's Signing & Capabilities, searching "hotspot" returns **No Matches**.
  Xcode hides capabilities the team can't use, so Hotspot Configuration is not
  available on the free Personal Team.

Not proven: no run has had the entitlements. Only worth pursuing (paid team) if the
Info.plist fix above doesn't get frames flowing.

Other things that were ruled out or are unlikely:
- Bluetooth off or denied: user confirmed Bluetooth is on and allowed for both
  Meta AI and the relay. The `CBCentralManager ... powered on state` log line is
  most likely a harmless startup blip.
- Stream settings: the error is `deviceNotConnected`, not a config error, and
  the ladder already tried `raw/high/15` then `raw/medium/15`.
- Developer Mode, compatibility, app or firmware updates: state line says
  `Compatible`, and there was no "update required" message.

Log noise that is safe to ignore: `quic_*`, `nw_connection_*`, `nw_protocol_instance_*`,
the `debug dylib` lines, and `XPC connection invalid`.

## Options

1. **Sign with a paid Apple Developer team.** Add Hotspot Configuration, Access
   WiFi Information and Keychain Sharing under Signing & Capabilities, rerun. Needs
   someone on the team who already has an active membership (enrolling is $99 and
   not instant). Check Xcode → Settings → Accounts: "Personal Team" is free.
2. **WhatsApp fallback (already built).** Glasses → WhatsApp video call on a phone
   → screen-share the call window to the laptop with the capture app's **Share
   screen** button. Needs no Apple entitlements. Risk: decoding the badge beacon
   over a recompressed call stream is unproven; test it early.
3. **Ask Meta or the hackathon staff** whether the SDK has a mode that works
   without the Hotspot entitlement. None was found in the SDK docs.

Recommendation: rerun with the Info.plist fix first. Keep option 2 ready as the
safety net, and pursue option 1 only if the stream still fails and someone already
has a paid team.

## Open risks, even once the stream works

- **Network topology.** If the phone joins a Wi-Fi network hosted by the glasses,
  it may drop the venue Wi-Fi, and the laptop then can't reach `ws://<phone-ip>:8080`.
  Untested idea: Personal Hotspot over the USB cable to the Mac.
- **Beacon decode quality.** Whether the static key decodes off a chest-worn
  badge at glasses resolution is unmeasured. 720×1280 is the SDK ceiling.
- **No authentication on the frame server.** Anyone on the same network who knows
  the address and port can watch the feed. Fine on a private hotspot, not on shared
  Wi-Fi. A shared token would fix it.
- **Free-team apps expire after 7 days.**
- The relay is installed on Maaz's phone, signed with a personal Apple ID. Remove
  it after the demo.

## Doc fixes still owed

- `glasses-relay/README.md` still shows a three-step Xcode setup that predates the
  real project layout, and does not mention the Wi-Fi entitlements or the paid-team
  requirement.
- `glasses-relay/ConsentinelRelay/` and `ConsentinelRelay-xcode/ConsentinelRelay-xcode/`
  hold duplicate Swift files. The Xcode copy is the one built; keep them in sync or
  delete the originals.
- `glasses-relay/ConsentinelRelay/Info.plist` was reformatted by Xcode (comments
  removed, keys reordered). Contents are equivalent.

## Key facts

- SDK: `https://github.com/facebook/meta-wearables-dat-ios`, exact version 0.9.0.
  Meta's sample and SDK are under Meta's Developer Terms, so nothing of theirs is
  vendored in this repo.
- Bundle id: `com.hashimb.consentinel.relay`. URL scheme: `consentinelrelay://`.
- Frame server port: 8080. Address shown in the app.
- Capture app: glasses address box sits next to the **Glasses** button; the
  address is stored under localStorage key `consentinel.glasses`.
- Compile check without a device:
  `xcodebuild -project ConsentinelRelay-xcode.xcodeproj -scheme ConsentinelRelay-xcode -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build`
