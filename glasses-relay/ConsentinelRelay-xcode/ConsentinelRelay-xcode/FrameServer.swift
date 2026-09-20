import Foundation
import Network
import os

/// Broadcasts JPEG frames over WebSocket to whoever connects — in practice the
/// Consentinel capture app running in a browser on the laptop.
///
/// Network.framework speaks WebSocket natively, so the handshake, framing and
/// masking are already handled; what's left is a client list and backpressure.
final class FrameServer: @unchecked Sendable {
  private static let log = Logger(subsystem: "com.consentinel.relay", category: "FrameServer")

  let port: UInt16
  /// Called on the main actor whenever a client connects or disconnects.
  var onClientCount: (@MainActor @Sendable (Int) -> Void)?

  private let queue = DispatchQueue(label: "com.consentinel.relay.frames")
  private var listener: NWListener?
  /// Connection plus whether a send is still in flight. Only touched on `queue`.
  private var clients: [ObjectIdentifier: (conn: NWConnection, sending: Bool)] = [:]

  init(port: UInt16 = 8080) { self.port = port }

  func start() throws {
    let params = NWParameters.tcp
    params.allowLocalEndpointReuse = true
    let ws = NWProtocolWebSocket.Options(.version13)
    ws.autoReplyPing = true
    params.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)

    let listener = try NWListener(using: params, on: NWEndpoint.Port(rawValue: port)!)
    listener.newConnectionHandler = { [weak self] conn in self?.accept(conn) }
    listener.start(queue: queue)
    self.listener = listener
    Self.log.info("listening on \(self.port)")
  }

  func stop() {
    listener?.cancel()
    listener = nil
    queue.async {
      for client in self.clients.values { client.conn.cancel() }
      self.clients.removeAll()
      self.publishCount()
    }
  }

  /// Sends a frame to every client that isn't still sending the previous one.
  /// Dropping frames for a slow client is right for a live feed — queueing them
  /// would just grow latency until the preview runs minutes behind the room.
  func broadcast(_ jpeg: Data) {
    queue.async {
      for (key, client) in self.clients where !client.sending {
        self.clients[key]?.sending = true
        let meta = NWProtocolWebSocket.Metadata(opcode: .binary)
        let context = NWConnection.ContentContext(identifier: "frame", metadata: [meta])
        client.conn.send(
          content: jpeg, contentContext: context, isComplete: true,
          // Delivered on `queue`, the same queue the connection was started on.
          completion: .contentProcessed { [weak self] _ in self?.clients[key]?.sending = false })
      }
    }
  }

  // MARK: - Connections

  private func accept(_ conn: NWConnection) {
    let key = ObjectIdentifier(conn)
    conn.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        self.clients[key] = (conn, false)
        self.publishCount()
      case .failed, .cancelled:
        self.clients.removeValue(forKey: key)
        self.publishCount()
      default:
        break
      }
    }
    conn.start(queue: queue)
    receive(conn)
  }

  /// Nothing the browser sends is interesting, but a receive loop has to be
  /// running for the connection to notice the peer going away.
  private func receive(_ conn: NWConnection) {
    conn.receiveMessage { [weak self] _, context, _, error in
      guard let self, error == nil else { return }
      let meta = context?.protocolMetadata(definition: NWProtocolWebSocket.definition)
      if let ws = meta as? NWProtocolWebSocket.Metadata, ws.opcode == .close {
        conn.cancel()
        return
      }
      self.receive(conn)
    }
  }

  private func publishCount() {
    let count = clients.count
    let notify = onClientCount
    Task { @MainActor in notify?(count) }
  }
}

/// The phone's Wi-Fi / Personal Hotspot IPv4 address, so the demo can read the
/// URL off the screen instead of digging through Settings.
func localIPv4() -> String? {
  var head: UnsafeMutablePointer<ifaddrs>?
  guard getifaddrs(&head) == 0, let first = head else { return nil }
  defer { freeifaddrs(head) }

  for ptr in sequence(first: first, next: { $0.pointee.ifa_next }) {
    let flags = Int32(ptr.pointee.ifa_flags)
    guard flags & IFF_UP != 0, flags & IFF_LOOPBACK == 0 else { continue }
    guard let addr = ptr.pointee.ifa_addr, addr.pointee.sa_family == UInt8(AF_INET) else { continue }
    // en0 is Wi-Fi; bridge100 is Personal Hotspot, which is how the laptop
    // reaches the phone when the venue network blocks device-to-device traffic.
    let name = String(cString: ptr.pointee.ifa_name)
    guard name == "en0" || name.hasPrefix("bridge") else { continue }

    var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    let ok = getnameinfo(
      addr, socklen_t(addr.pointee.sa_len), &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
    if ok == 0 { return String(cString: host) }
  }
  return nil
}
