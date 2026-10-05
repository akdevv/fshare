import Foundation

// Finds other phones running fshare on the same Wi-Fi or hotspot (Bonjour). The server announces
// this phone itself (PeerServer's NWListener service).
// ponytail: NetService is deprecated but still the simplest way to get an IP and the TXT record.
final class Nearby: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  private let emit: Emit
  private let browser = NetServiceBrowser()
  private var services = Set<NetService>() // NetService only calls back while something holds it

  init(emit: @escaping Emit) {
    self.emit = emit
    super.init()
    browser.delegate = self
  }

  // NetService needs a run loop: keep it on the main one
  func discover() { DispatchQueue.main.async { self.browser.searchForServices(ofType: "_fshare._tcp.", inDomain: "local.") } }

  func stop() {
    DispatchQueue.main.async {
      self.browser.stop()
      self.services.forEach { $0.stop(); $0.stopMonitoring() }
      self.services.removeAll()
    }
  }

  func netServiceBrowser(_ b: NetServiceBrowser, didFind s: NetService, moreComing: Bool) {
    services.insert(s)
    s.delegate = self
    s.resolve(withTimeout: 10)
  }

  func netServiceBrowser(_ b: NetServiceBrowser, didRemove s: NetService, moreComing: Bool) {
    services.remove(s)
    emit("peerLost", ["name": s.name])
  }

  func netServiceDidResolveAddress(_ s: NetService) {
    report(s)
    s.startMonitoring() // TXT changes: the other phone turned visibility on or off
  }

  func netService(_ s: NetService, didUpdateTXTRecord data: Data) { report(s) }

  private func report(_ s: NetService) {
    guard let host = s.addresses?.lazy.compactMap(ipv4).first, s.port > 0 else { return }
    let txt = s.txtRecordData().map { NetService.dictionary(fromTXTRecord: $0) } ?? [:]
    emit("peerFound", [
      "name": s.name, "host": host, "port": s.port,
      "id": txt["id"].map { String(decoding: $0, as: UTF8.self) } ?? "",
      "hidden": txt["hidden"] != nil,
    ])
  }

  private func ipv4(_ d: Data) -> String? {
    d.withUnsafeBytes { p -> String? in
      guard let base = p.baseAddress, p.count >= MemoryLayout<sockaddr_in>.size,
            base.assumingMemoryBound(to: sockaddr.self).pointee.sa_family == sa_family_t(AF_INET) else { return nil }
      var addr = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
      var buf = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
      return inet_ntop(AF_INET, &addr, &buf, socklen_t(INET_ADDRSTRLEN)).map { _ in String(cString: buf) }
    }
  }
}
