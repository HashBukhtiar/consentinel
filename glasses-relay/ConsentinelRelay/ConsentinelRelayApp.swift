import MWDATCamera
import MWDATCore
import SwiftUI
import UIKit

/// Tuning knobs for the optical beacon. Glasses frames reach the phone over
/// Bluetooth, and the SDK trades quality for bandwidth on its own, so these are
/// requests rather than guarantees — check `Relay.status` for what you got.
enum RelayConfig {
  /// Beacon decoding wants pixels far more than it wants frames: the static key
  /// decodes off a single clean frame. Ask for the most pixels available.
  static let resolution: StreamingResolution = .high  // 720 x 1280
  /// Valid: 2, 7, 15, 24, 30. Lower rates compress less, so the badge patch
  /// stays sharper — 15 keeps face tracking smooth without wrecking the patch.
  static let frameRate: UInt = 15
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

// MARK: - Relay

/// Glasses camera → JPEG → WebSocket. Everything the app actually does.
@MainActor @Observable
final class Relay {
  var status = "Idle"
  var streaming = false
  var clients = 0
  var frames = 0
  var preview: UIImage?

  var url: String { "ws://\(localIPv4() ?? "<phone-ip>"):\(RelayConfig.port)" }

  private let wearables = Wearables.shared
  private let tokens = ListenerTokenBag()
  private var session: DeviceSession?
  private var camera: Camera?
  // nonisolated: the SDK delivers frames off the main actor and we broadcast
  // from there, so this must not be main-actor isolated.
  nonisolated private let server = FrameServer(port: RelayConfig.port)

  func start() async {
    server.onClientCount = { [weak self] count in self?.clients = count }
    do {
      try server.start()
    } catch {
      status = "Can't open port \(RelayConfig.port) — \(error.localizedDescription)"
      return
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

    status = "Asking the glasses for camera permission…"
    do {
      guard try await wearables.requestPermission(.camera) == .granted else {
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
      let session = try wearables.createSession(deviceSelector: selector)
      self.session = session
      try session.start()

      // addCamera only works once the session has actually started.
      for await state in session.stateStream() {
        if state == .started { break }
        if state == .stopped {
          status = "The session stopped before it started. Are the glasses awake?"
          return
        }
      }

      let config = StreamConfiguration(
        videoCodec: .raw,  // .raw gives decoded frames, so makeUIImage() just works
        resolution: RelayConfig.resolution,
        frameRate: RelayConfig.frameRate)
      guard let camera = try session.addCamera(config: config) else {
        status = "Couldn't add the camera capability."
        return
      }
      self.camera = camera
      listen(to: camera.stream)
      camera.stream.start()
      status = "Waiting for frames…"
    } catch {
      status = "Session error — \(error.localizedDescription)"
    }
  }

  func stop() {
    camera?.stop()
    camera = nil
    session?.stop()
    session = nil
    tokens.clear()
    server.stop()
    streaming = false
    frames = 0
    preview = nil
    status = "Idle"
  }

  private func listen(to stream: MWDATCamera.Stream) {
    stream.statePublisher.listen { [weak self] state in
      Task { @MainActor in
        guard let self else { return }
        self.streaming = state == .streaming
        switch state {
        case .streaming: self.status = "Streaming"
        case .waitingForDevice: self.status = "Waiting for the glasses to connect…"
        case .paused: self.status = "Paused — the glasses hinges may be closed."
        case .stopped: self.status = "Stream stopped."
        default: break
        }
      }
    }.store(in: tokens)

    stream.videoFramePublisher.listen { [weak self] frame in
      guard let self else { return }
      // Runs on the SDK's delivery queue — encode here, off the main actor.
      guard let image = frame.makeUIImage(),
        let jpeg = image.jpegData(compressionQuality: RelayConfig.jpegQuality)
      else { return }
      self.server.broadcast(jpeg)
      // Hand Data (not UIImage) across the actor hop — no Sendable questions.
      Task { @MainActor in
        self.preview = UIImage(data: jpeg)
        self.frames += 1
      }
    }.store(in: tokens)

    stream.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.status = "Stream error — \(error.localizedDescription)" }
    }.store(in: tokens)
  }
}

// MARK: - View

struct RelayView: View {
  @Bindable var relay: Relay

  var body: some View {
    VStack(spacing: 16) {
      Text("Consentinel Relay").font(.title2.bold())

      ZStack {
        RoundedRectangle(cornerRadius: 12).fill(.black)
        if let preview = relay.preview {
          Image(uiImage: preview).resizable().scaledToFit()
        } else {
          Text("No frames yet").foregroundStyle(.secondary)
        }
      }
      .frame(maxWidth: .infinity, maxHeight: 360)
      .clipShape(RoundedRectangle(cornerRadius: 12))

      Text(relay.status).font(.callout).multilineTextAlignment(.center)

      // The address to paste into the capture app on the laptop.
      Text(relay.url)
        .font(.system(.body, design: .monospaced))
        .textSelection(.enabled)
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))

      HStack(spacing: 20) {
        Label("\(relay.clients)", systemImage: "laptopcomputer")
        Label("\(relay.frames)", systemImage: "photo.stack")
      }
      .font(.footnote.monospacedDigit())
      .foregroundStyle(.secondary)

      if relay.streaming {
        Button("Stop", role: .destructive) { relay.stop() }
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
