import Foundation
import Network

typealias Emit = (String, [String: Any?]) -> Void

// The receiving half of fshare on an iPhone. Same HTTP as PeerServer.kt on Android (and the laptop
// CLI), so any phone sends here with the upload code it already has:
//   POST /hello?name=&port=&token=&id= Wi-Fi pairing: asks the user here to accept, then returns the token
//   GET  /list                         [] (phones push, they don't publish files) + name headers
//   GET|PUT|DELETE /upload?id=         resumable upload; finished parts are handed to JS to save
// Everything runs on one serial queue. ponytail: no TLS, same as the laptop and Android.
final class PeerServer {
  let q = DispatchQueue(label: "fshare-server")
  let name: String
  private let port: UInt16
  private let token: String
  private let id: String
  private let parts: URL
  private let emit: Emit
  private var visible: Bool
  private var listener: NWListener?
  private var stopped = false
  private var pairs = [String: (Bool) -> Void]()
  private var uploads = [String: Conn]()
  private var cancelled = Set<String>()

  init(port: UInt16, token: String, name: String, id: String, visible: Bool, parts: URL, emit: @escaping Emit) {
    self.port = port; self.token = token; self.name = name; self.id = id
    self.visible = visible; self.parts = parts; self.emit = emit
  }

  func start() {
    try? FileManager.default.createDirectory(at: parts, withIntermediateDirectories: true)
    q.async { self.listen() }
  }

  func stop() {
    q.async {
      self.stopped = true
      self.listener?.cancel()
      self.uploads.values.forEach { $0.close() }
      self.pairs.values.forEach { $0(false) }
    }
  }

  // iOS tears the listener down while the app is in the background; start over when it fails
  private func listen() {
    guard !stopped else { return }
    guard let l = try? NWListener(using: .tcp, on: NWEndpoint.Port(rawValue: port)!) else { return retry() }
    l.service = service()
    l.newConnectionHandler = { [weak self] c in
      guard let self else { return c.cancel() }
      Conn(c, self).start()
    }
    l.stateUpdateHandler = { [weak self] st in
      if case .failed = st { l.cancel(); self?.retry() }
    }
    l.start(queue: q)
    listener = l
  }

  private func retry() {
    listener = nil
    q.asyncAfter(deadline: .now() + 2) { [weak self] in self?.listen() }
  }

  // hidden phones still announce (so phones they're paired with can find their new address),
  // but with hidden=1, and the app leaves them out of everyone else's Nearby list
  private func service() -> NWListener.Service {
    var txt = NWTXTRecord()
    txt["id"] = id
    if !visible { txt["hidden"] = "1" }
    return NWListener.Service(name: name, type: "_fshare._tcp", domain: nil, txtRecord: txt)
  }

  func setVisible(_ v: Bool) { q.async { self.visible = v; self.listener?.service = self.service() } }
  func answer(_ id: String, _ ok: Bool) { q.async { self.pairs[id]?(ok) } }

  // receiver taps cancel: drop the connection (the sender sees it fail) and the partial file
  func cancel(_ id: String) {
    q.async {
      self.cancelled.insert(id)
      if let k = self.uploads[id] { k.close() } else { try? FileManager.default.removeItem(at: self.part(id)) }
    }
  }

  private func part(_ id: String) -> URL {
    let safe = String(id.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }.prefix(80))
    return parts.appendingPathComponent(safe.isEmpty ? "x" : safe)
  }

  private func size(_ id: String) -> Int64 {
    ((try? FileManager.default.attributesOfItem(atPath: part(id).path))?[.size] as? NSNumber)?.int64Value ?? 0
  }

  func route(_ k: Conn, _ r: Request) {
    // read past any body, then answer
    let reply = { (code: Int, body: String, type: String) in
      k.body(r.length, { _ in true }) { ok in ok ? k.respond(code, body, type) : k.close() }
    }
    if r.path == "/pair" { return reply(403, "", "text/plain") } // only the Android USB cable uses this
    if r.method == "POST" && r.path == "/hello" { return k.body(r.length, { _ in true }) { ok in ok ? self.hello(k, r) : k.close() } }
    guard r.query["t"] == token else { return reply(403, "bad token", "text/plain") }
    if r.method == "GET" && r.path == "/list" { return reply(200, "[]", "application/json") }
    if r.path == "/upload", let id = r.query["id"] {
      switch r.method {
      case "GET": return reply(200, "{\"received\":\(size(id))}", "application/json")
      case "DELETE":
        try? FileManager.default.removeItem(at: part(id))
        emit("stopped", ["id": id, "reason": "cancelled"])
        return reply(200, "ok", "text/plain")
      case "PUT": return upload(k, r, id)
      default: break
      }
    }
    reply(404, "", "text/plain")
  }

  private func hello(_ k: Conn, _ r: Request) {
    guard visible else { return k.respond(403, "hidden") }
    let id = UUID().uuidString
    var answered = false
    let finish = { (ok: Bool) in
      if answered { return }
      answered = true
      self.pairs[id] = nil
      ok ? k.respond(200, self.token) : k.respond(403, "declined")
    }
    pairs[id] = finish
    emit("pairRequest", [
      "id": id, "name": r.query["name"] ?? "Phone", "host": k.host,
      "port": Int(r.query["port"] ?? "") ?? 0, "token": r.query["token"] ?? "", "peer": r.query["id"] ?? "",
    ])
    q.asyncAfter(deadline: .now() + 60) { finish(false) }
  }

  private func upload(_ k: Conn, _ r: Request, _ id: String) {
    let name = (r.query["name"] ?? "").components(separatedBy: "/").last!.trimmingCharacters(in: .whitespaces)
    let offset = Int64(r.query["offset"] ?? "") ?? 0
    let total = Int64(r.query["size"] ?? "") ?? Int64(r.length)
    let f = part(id)
    let have = size(id)
    let refuse = { (code: Int, body: String, type: String) in
      k.body(r.length, { _ in true }) { ok in ok ? k.respond(code, body, type) : k.close() }
    }
    if name.isEmpty || name == "." || name == ".." { return refuse(400, "bad name", "text/plain") }
    if offset > have { return refuse(409, "{\"received\":\(have)}", "application/json") }
    if !FileManager.default.fileExists(atPath: f.path) { FileManager.default.createFile(atPath: f.path, contents: nil) }
    guard let h = try? FileHandle(forWritingTo: f) else { return refuse(400, "can't write", "text/plain") }
    try? h.truncate(atOffset: UInt64(offset))
    cancelled.remove(id)
    uploads[id] = k
    let from = r.headers["x-fshare-client"]?.removingPercentEncoding ?? "Phone"
    var done = offset
    var last = Date.distantPast
    let info = { () -> [String: Any?] in ["id": id, "name": name, "from": from, "done": Double(done), "total": Double(total)] }
    emit("progress", info())
    k.body(r.length, { d in
      guard (try? h.write(contentsOf: d)) != nil else { return false }
      done += Int64(d.count)
      if Date().timeIntervalSince(last) >= 0.25 { last = Date(); self.emit("progress", info()) }
      return true
    }) { ok in
      try? h.close()
      self.uploads[id] = nil
      guard ok else {
        if self.cancelled.remove(id) != nil {
          try? FileManager.default.removeItem(at: f)
          self.emit("stopped", ["id": id, "reason": "cancelled"])
        } else {
          self.emit("stopped", ["id": id, "reason": "paused", "done": Double(self.size(id))])
        }
        return k.close()
      }
      if self.size(id) != total { return k.respond(400, "incomplete") }
      self.emit("progress", info())
      self.emit("received", ["id": id, "name": name, "from": from, "uri": f.absoluteString, "size": Double(total)])
      k.respond(200, "ok")
    }
  }
}

struct Request {
  let method: String
  let path: String
  let query: [String: String]
  let headers: [String: String]
  var length: Int { Int(headers["content-length"] ?? "") ?? 0 }

  init(_ head: String) {
    let lines = head.components(separatedBy: "\r\n")
    let first = lines.first?.split(separator: " ") ?? []
    method = first.first.map(String.init) ?? ""
    let url = URLComponents(string: "http://x" + (first.count > 1 ? String(first[1]) : "/"))
    path = url?.path ?? "/"
    var q = [String: String]()
    url?.queryItems?.forEach { q[$0.name] = $0.value ?? "" }
    query = q
    var h = [String: String]()
    for l in lines.dropFirst() {
      guard let i = l.firstIndex(of: ":") else { continue }
      h[l[..<i].trimmingCharacters(in: .whitespaces).lowercased()] = l[l.index(after: i)...].trimmingCharacters(in: .whitespaces)
    }
    headers = h
  }
}

// One keep-alive HTTP connection: read a request head, let the server route it, repeat.
final class Conn {
  private let c: NWConnection
  private let s: PeerServer
  private var buf = Data()

  init(_ c: NWConnection, _ s: PeerServer) { self.c = c; self.s = s }

  var host: String {
    guard case .hostPort(let h, _) = c.endpoint else { return "" }
    var out: String
    switch h {
    case .ipv4(let a): out = "\(a)"
    case .ipv6(let a): out = "\(a)"
    case .name(let n, _): out = n
    @unknown default: out = ""
    }
    if let i = out.firstIndex(of: "%") { out = String(out[..<i]) } // "192.168.1.5%en0"
    if out.hasPrefix("::ffff:") { out = String(out.dropFirst(7)) }
    return out
  }

  func start() {
    c.stateUpdateHandler = { [weak self] st in
      switch st {
      case .failed: self?.c.cancel()
      case .cancelled: self?.c.stateUpdateHandler = nil
      default: break
      }
    }
    c.start(queue: s.q)
    head()
  }

  func close() { c.cancel() }

  private func head() {
    if let r = buf.range(of: Data("\r\n\r\n".utf8)) {
      let text = String(decoding: buf[..<r.lowerBound], as: UTF8.self)
      buf = Data(buf[r.upperBound...])
      return s.route(self, Request(text))
    }
    if buf.count > 16384 { return close() }
    c.receive(minimumIncompleteLength: 1, maximumLength: 65536) { d, _, _, err in
      guard err == nil, let d, !d.isEmpty else { return self.close() }
      self.buf.append(d)
      self.head()
    }
  }

  // the next n body bytes go to `sink` (false stops), then done(true); done(false) if the connection drops
  func body(_ n: Int, _ sink: @escaping (Data) -> Bool, _ done: @escaping (Bool) -> Void) {
    var left = n
    if left > 0 && !buf.isEmpty {
      let k = min(left, buf.count)
      let chunk = Data(buf.prefix(k))
      buf = Data(buf.dropFirst(k))
      left -= k
      if !sink(chunk) { return done(false) }
    }
    if left == 0 { return done(true) }
    c.receive(minimumIncompleteLength: 1, maximumLength: min(left, 1 << 18)) { d, _, _, err in
      guard err == nil, let d, !d.isEmpty, sink(d) else { return done(false) }
      self.body(left - d.count, sink, done)
    }
  }

  func respond(_ code: Int, _ body: String, _ type: String = "text/plain") {
    let b = Data(body.utf8)
    let reason = [200: "OK", 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 409: "Conflict"][code] ?? "OK"
    let name = s.name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ""
    let head = "HTTP/1.1 \(code) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(b.count)\r\n" +
      "x-fshare-name: \(name)\r\nx-fshare-version: 2\r\nx-fshare-kind: phone\r\nConnection: keep-alive\r\n\r\n"
    c.send(content: Data(head.utf8) + b, completion: .contentProcessed { err in
      if err != nil { self.close() } else { self.head() }
    })
  }
}
