import MWDATCamera
import MWDATCore
import SwiftUI
import UIKit
import os

/// Tuning knobs for the optical beacon. Glasses frames reach the phone over
/// Bluetooth, and the SDK trades quality for bandwidth on its own, so these are
/// requests rather than guarantees — check `Relay.status` for what you got.
enum RelayConfig {
  struct Resolution: Sendable {
    let label: String
    let value: StreamingResolution
  }
  /// Selectable in the app, live. Lower resolution and rate get compressed less over
  /// the glasses link, so they hold up better; the SDK also drops these on its own
  /// (resolution first, then rate) when the link is short of bandwidth.
  static let resolutions: [Resolution] = [
    Resolution(label: "high 720×1280", value: .high),
    Resolution(label: "medium 504×896", value: .medium),
    Resolution(label: "low 360×640", value: .low),
  ]
  static let frameRates: [UInt] = [2, 7, 15, 24, 30]  // the only values the SDK accepts
  /// Re-encode quality for the hop to the laptop. Below ~0.6 the beacon's
  /// cell edges start to ring and decode rates drop.
  static let jpegQuality: CGFloat = 0.7
  static let port: UInt16 = 8080
}

@main
struct ConsentinelRelayApp: App {
  @State private var relay = Relay()

  init() {
    do {
      try Wearables.configure()
    } catch {
      NSLog("[Relay] Wearables.configure failed: \(error)")
    }
  }

  var body: some Scene {
    WindowGroup {
      RelayView(relay: relay)
        // Meta AI bounces back into this app after linking via the URL scheme.
        .onOpenURL { url in
          Task { _ = try? await Wearables.shared.handleUrl(url) }
        }
    }
  }
}

// MARK: - Frame gate

/// Keeps a slow encode from backing up the SDK's frame delivery: while one frame
/// is being encoded, later ones are dropped rather than queued. Also thins the
/// on-screen preview, which doesn't need every frame.
final class FrameGate: @unchecked Sendable {
  private let lock = OSAllocatedUnfairLock(initialState: (busy: false, count: 0))
  func begin() -> Bool {
    lock.withLock { state in
      if state.busy { return false }
      state.busy = true
      return true
    }
  }
  func end() { lock.withLock { $0.busy = false } }
  func wantPreview() -> Bool {
    lock.withLock { state in
      state.count += 1
      return state.count % 3 == 0
    }
  }
}

// MARK: - Relay

/// Glasses camera → JPEG → WebSocket. Everything the app actually does.
@MainActor @Observable
final class Relay {
  var status = "Idle"
  var streaming = false
  /// True from Start until Stop, even while stuck — so Stop is always reachable
  /// and a second Start can't stack a second session on the first.
  var active = false
  var clients = 0
  var frames = 0
  var fps = 0
  var restarts = 0
  private var frameAge = 0.0  // seconds since the last frame arrived
  private var lastFrameAt = Date()
  private var restarting = false
  /// Stream settings. Changing either while streaming restarts the camera with them.
  var resolutionIndex = 0
  var frameRate: UInt = 15
  private var frameSize = "–"  // what actually arrives; the SDK may have downscaled
  var preview: UIImage?
  /// The glasses' companion app needs updating; offer the deep link to do it.
  var glassesUpdateNeeded = false

  private var sessionText = "–"
  private var streamTrail = "–"  // every stream state seen, in order
  private var linkText = "–"
  private var compatText = "–"
  private var configText = "–"
  private var lastError = ""  // kept apart from `status`, which .stopped would overwrite
  /// One line of raw SDK state — what to read out when nothing streams.
  var detail: String {
    var line = "session \(sessionText) · stream \(streamTrail) · link \(linkText) · \(compatText) · cfg \(configText) · got \(frameSize) · last frame \(Int(frameAge))s · restarts \(restarts)"
    if !lastError.isEmpty { line += " · ERR \(lastError)" }
    return line
  }

  var url: String { "ws://\(localIPv4() ?? "<phone-ip>"):\(RelayConfig.port)" }

  private let wearables = Wearables.shared
  private let tokens = ListenerTokenBag()  // session + device listeners
  private let streamTokens = ListenerTokenBag()  // one attempt's stream listeners
  private var session: DeviceSession?
  private var camera: Camera?
  private var serverRunning = false
  private var hasStreamed = false
  // nonisolated: the SDK delivers frames off the main actor and we broadcast
  // from there, so this must not be main-actor isolated.
  nonisolated private let server = FrameServer(port: RelayConfig.port)
  nonisolated private let gate = FrameGate()
  private var fpsTask: Task<Void, Never>?

  func start() async {
    guard !active else { return }
    active = true
    glassesUpdateNeeded = false
    // A locked or dimmed screen backgrounds the app, and the SDK ends the stream
    // when that happens — so keep the display awake for as long as we're relaying.
    UIApplication.shared.isIdleTimerDisabled = true
    fpsTask?.cancel()
    fpsTask = Task { [weak self] in
      var last = 0
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(1))
        guard let self else { return }
        self.fps = max(0, self.frames - last)
        last = self.frames
        self.frameAge = Date().timeIntervalSince(self.lastFrameAt)
        // Watchdog: the stream says it's live but no frame has arrived for 4 s — the
        // freeze. Rebuild the camera on the same settings instead of waiting it out.
        if self.streaming, self.frameAge > 4, !self.restarting {
          self.restarting = true
          await self.restartStream()
          self.restarting = false
        }
      }
    }
    await teardownSession()

    if !serverRunning {
      server.onClientCount = { [weak self] count in self?.clients = count }
      do {
        try server.start()
        serverRunning = true
      } catch {
        status = "Can't open port \(RelayConfig.port) — \(error.localizedDescription)"
        active = false
        return
      }
    }

    if wearables.registrationState != .registered {
      status = "Linking through Meta AI…"
      do {
        try await wearables.startRegistration()
      } catch {
        status = "Registration failed — \(error.localizedDescription)"
        return
      }
    }

    // Check first: re-requesting sends the user through Meta AI on every Start.
    status = "Checking camera permission on the glasses…"
    do {
      var permission = try await wearables.checkPermissionStatus(.camera)
      if permission != .granted {
        status = "Asking the glasses for camera permission…"
        permission = try await wearables.requestPermission(.camera)
      }
      guard permission == .granted else {
        status = "Camera permission denied on the glasses."
        return
      }
    } catch {
      status = "Permission error — \(error.localizedDescription)"
      return
    }

    status = "Starting session…"
    do {
      let selector = AutoDeviceSelector(wearables: wearables)
      // The selector fills in asynchronously; createSession throws
      // noEligibleDevice if it hasn't found a device yet.
      status = "Looking for your glasses…"
      guard await waitForDevice(selector, seconds: 20) else {
        status = "No eligible glasses found. " + describeDevices()
        return
      }
      let session = try wearables.createSession(deviceSelector: selector)
      self.session = session
      observe(session)
      try session.start()

      // addCamera only works once the session has actually started.
      for await state in session.stateStream() {
        if state == .started { break }
        if state == .stopped {
          status = "The session stopped before it started. Are the glasses awake?"
          return
        }
      }

      try beginStream()
      status = "Waiting for frames…"
    } catch {
      status = "Session error — \(error.localizedDescription)"
    }
  }

  /// Adds a camera with the currently selected resolution and frame rate and starts it.
  private func beginStream() throws {
    guard let session else { return }
    let resolution = RelayConfig.resolutions[resolutionIndex]
    let config = StreamConfiguration(videoCodec: .raw, resolution: resolution.value, frameRate: frameRate)
    guard let camera = try session.addCamera(config: config) else {
      status = "Couldn't add the camera capability."
      return
    }
    self.camera = camera
    hasStreamed = false
    configText = "\(resolution.label.split(separator: " ")[0])/\(frameRate)fps"
    lastFrameAt = Date()
    streamTrail = "–"
    lastError = ""
    listen(to: camera.stream)
    camera.stream.start()
    status = "Waiting for frames…"
  }

  /// Called when a picker changes: rebuild the camera with the new settings.
  func applySettings() {
    guard active, session != nil, camera != nil, !restarting else { return }
    restarting = true
    Task {
      await restartStream(countAsRestart: false)
      restarting = false
    }
  }

  /// Tears down the camera and starts it again on the same settings. The session
  /// (and the link to the glasses) stays up, so this takes about a second.
  private func restartStream(countAsRestart: Bool = true) async {
    guard active, session != nil else { return }
    status = countAsRestart ? "No frames for a while — restarting the stream…" : "Applying new settings…"
    if countAsRestart { restarts += 1 }
    streamTokens.clear()
    camera?.stop()
    camera = nil
    streaming = false
    try? await Task.sleep(for: .milliseconds(800))
    guard active, session != nil else { return }
    do { try beginStream() } catch { status = "Session error — \(error.localizedDescription)" }
  }

  /// Ends the session but leaves the frame server up, so Start is instant and
  /// there's no port-rebind race. The browser stays connected across restarts.
  func stop() {
    active = false
    streaming = false
    fpsTask?.cancel()
    fpsTask = nil
    UIApplication.shared.isIdleTimerDisabled = false
    fps = 0
    frames = 0
    preview = nil
    glassesUpdateNeeded = false
    status = "Idle"
    Task { await teardownSession() }
  }

  func openGlassesUpdate() {
    Task { try? await wearables.openDATGlassesAppUpdate() }
  }

  /// Fully retires the current session. Waits for `.stopped`, because creating
  /// another session while the old one is still stopping throws sessionAlreadyExists.
  private func teardownSession() async {
    tokens.clear()
    streamTokens.clear()
    camera?.stop()
    camera = nil
    let old = session
    session = nil
    sessionText = "–"; streamTrail = "–"; linkText = "–"; compatText = "–"; configText = "–"; frameSize = "–"; lastError = ""
    guard let old else { return }
    old.stop()
    let deadline = Date().addingTimeInterval(3)
    while old.state != .stopped, Date() < deadline {
      try? await Task.sleep(for: .milliseconds(100))
    }
  }

  /// Polls the selector until it names a device. Polling rather than iterating
  /// `activeDeviceStream()` so a stream that never yields can't hang the caller.
  private func waitForDevice(_ selector: AutoDeviceSelector, seconds: Double) async -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
      if selector.activeDevice != nil { return true }
      try? await Task.sleep(for: .milliseconds(500))
    }
    return false
  }

  /// What the SDK knows about each glasses, for the status line when nothing is eligible.
  private func describeDevices() -> String {
    let ids = wearables.devices
    if ids.isEmpty { return "The SDK sees no glasses — check they're paired in Meta AI with Developer Mode on." }
    return ids.compactMap { wearables.deviceForIdentifier($0) }
      .map { "[\($0.linkState), \($0.compatibility().displayString)]" }
      .joined(separator: " ")
  }

  /// Session-level state and errors. Stream errors alone miss things like
  /// `datAppOnTheGlassesUpdateRequired`, which only arrives here.
  private func observe(_ session: DeviceSession) {
    session.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.sessionText = "\(state)" }
    }.store(in: tokens)

    session.errorPublisher.listen { [weak self] error in
      Task { @MainActor in
        guard let self else { return }
        if case .datAppOnTheGlassesUpdateRequired = error {
          self.glassesUpdateNeeded = true
          self.status = "The app on your glasses needs an update."
        } else {
          self.status = "Session error — \(error.localizedDescription)"
        }
      }
    }.store(in: tokens)

    if let device = wearables.deviceForIdentifier(session.deviceId) {
      linkText = "\(device.linkState)"
      compatText = device.compatibility().displayString
      device.addLinkStateListener { [weak self] state in
        Task { @MainActor in self?.linkText = "\(state)" }
      }.store(in: tokens)
      device.addCompatibilityListener { [weak self] compat in
        Task { @MainActor in self?.compatText = compat.displayString }
      }.store(in: tokens)
    }
  }

  private func listen(to stream: MWDATCamera.Stream) {
    stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        self.streamTrail = self.streamTrail == "–" ? "\(state)" : self.streamTrail + "→\(state)"
        self.streaming = state == .streaming
        switch state {
        case .streaming:
          self.hasStreamed = true
          self.status = "Streaming"
        case .waitingForDevice: self.status = "Waiting for the glasses to connect…"
        case .paused: self.status = "Paused — put the glasses on and tap the side."
        case .stopped:
          self.status = self.hasStreamed ? "Stream stopped." : "Stream stopped before any frame — try another setting."
        default: break
        }
      }
    }.store(in: streamTokens)

    stream.videoFramePublisher.listen { [weak self] frame in
      guard let self, self.gate.begin() else { return }  // drop, don't queue, if still encoding
      defer { self.gate.end() }
      // Runs on the SDK's delivery queue — encode here, off the main actor.
      guard let image = frame.makeUIImage() else {
        // Frames are arriving but this codec can't be rendered without a decoder.
        Task { @MainActor in
          self.hasStreamed = true
          self.status = "Frames arrive but can't be decoded (\(self.configText))."
        }
        return
      }
      guard let jpeg = image.jpegData(compressionQuality: RelayConfig.jpegQuality) else { return }
      self.server.broadcast(jpeg)
      let showPreview = self.gate.wantPreview()
      let size = "\(image.cgImage?.width ?? Int(image.size.width))×\(image.cgImage?.height ?? Int(image.size.height))"
      // Hand Data (not UIImage) across the actor hop — no Sendable questions.
      Task { @MainActor in
        self.hasStreamed = true
        self.lastFrameAt = Date()
        self.frameSize = size
        self.frames += 1
        if showPreview { self.preview = UIImage(data: jpeg) }
      }
    }.store(in: streamTokens)

    stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in
        // Kept in `lastError`: the .stopped that follows would overwrite `status`.
        self?.lastError = "\(error)"
      }
    }.store(in: streamTokens)
  }
}

// MARK: - View

struct RelayView: View {
  @Bindable var relay: Relay

  var body: some View {
    VStack(spacing: 14) {
      Text("Consentinel Relay").font(.title2.bold())

      ZStack {
        RoundedRectangle(cornerRadius: 12).fill(.black)
        if let preview = relay.preview {
          Image(uiImage: preview).resizable().scaledToFit()
        } else {
          Text("No frames yet").foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: 320)
      .clipShape(RoundedRectangle(cornerRadius: 12))

      Text(relay.status).font(.callout).multilineTextAlignment(.center)

      // Raw SDK state: read this out when the status alone doesn't explain a stall.
      Text(relay.detail)
        .font(.system(.caption2, design: .monospaced))
        .foregroundStyle(.secondary)
        .multilineTextAlignment(.center)

      if relay.glassesUpdateNeeded {
        Button("Update the glasses app in Meta AI") { relay.openGlassesUpdate() }
          .buttonStyle(.bordered)
      }

      // The address to paste into the capture app on the laptop.
      Text(relay.url)
        .font(.system(.body, design: .monospaced))
        .textSelection(.enabled)
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))

      HStack(spacing: 20) {
        Label("\(relay.clients)", systemImage: "laptopcomputer")
        Label("\(relay.frames)", systemImage: "photo.stack")
        Label("\(relay.fps) fps", systemImage: "speedometer")
      }
      .font(.footnote.monospacedDigit())
      .foregroundStyle(.secondary)

      // Live: changing either restarts the camera with the new setting. Try lower values
      // if the stream lags or freezes; "got" in the state line is what actually arrives.
      HStack {
        Picker("Resolution", selection: $relay.resolutionIndex) {
          ForEach(RelayConfig.resolutions.indices, id: \.self) { Text(RelayConfig.resolutions[$0].label).tag($0) }
        }
        Picker("FPS", selection: $relay.frameRate) {
          ForEach(RelayConfig.frameRates, id: \.self) { Text("\($0) fps").tag($0) }
        }
      }
      .pickerStyle(.menu)
      .onChange(of: relay.resolutionIndex) { relay.applySettings() }
      .onChange(of: relay.frameRate) { relay.applySettings() }

      if relay.active {
        Button("Stop / reset", role: .destructive) { relay.stop() }
          .buttonStyle(.borderedProminent)
      } else {
        Button("Start") { Task { await relay.start() } }
          .buttonStyle(.borderedProminent)
      }

      Spacer()
    }
    .padding()
  }
}
