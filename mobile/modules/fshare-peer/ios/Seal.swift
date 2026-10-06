import CryptoKit
import Foundation

// End-to-end encryption, byte for byte the spec in cli/seal.ts (and Seal.kt):
// keys from the pairing token, signed requests, sealed messages, files sealed in 64 KiB chunks,
// and ECDH P-256 for pairing two phones.
enum Seal {
  static let ch = 65536
  private static let tag = 16
  private static let saltLen = 7

  struct Keys { let enc: SymmetricKey; let mac: SymmetricKey }

  static func hmac(_ key: Data, _ msg: Data) -> Data {
    Data(HMAC<SHA256>.authenticationCode(for: msg, using: SymmetricKey(data: key)))
  }

  private static var derived = [String: Keys]()
  private static let lock = NSLock()

  // derived once per token: every request and every chunk needs them
  static func keys(_ token: String) -> Keys {
    lock.lock()
    defer { lock.unlock() }
    if let k = derived[token] { return k }
    let root = hmac(Data("fshare-e2e-1".utf8), Data(token.utf8))
    let k = Keys(enc: SymmetricKey(data: hmac(root, Data("enc".utf8))), mac: SymmetricKey(data: hmac(root, Data("mac".utf8))))
    derived[token] = k
    return k
  }

  private static func mac(_ k: Keys, _ msg: Data) -> Data { Data(HMAC<SHA256>.authenticationCode(for: msg, using: k.mac)) }
  private static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }

  static func b64(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func unb64(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }

  static func sign(_ token: String, _ msg: String) -> String { hex(mac(keys(token), Data(msg.utf8)).prefix(16)) }

  // "GET /list?c=1&s=…" as it came off the wire
  static func verify(_ token: String, _ method: String, _ target: String) -> Bool {
    guard let r = target.range(of: "[?&]s=[0-9a-f]{32}$", options: .regularExpression) else { return false }
    let got = String(target[r].suffix(32))
    let want = sign(token, "\(method) \(target[..<r.lowerBound])")
    return zip(want.utf8, got.utf8).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0 && want.count == got.count
  }

  static func seal(_ token: String, _ data: Data) -> String {
    let box = try! AES.GCM.seal(data, using: keys(token).enc)
    return b64(box.combined!)
  }

  static func open(_ token: String, _ sealed: String) -> Data? {
    guard let b = unb64(sealed), b.count >= 12 + tag, let box = try? AES.GCM.SealedBox(combined: b) else { return nil }
    return try? AES.GCM.open(box, using: keys(token).enc)
  }

  static func openText(_ token: String, _ sealed: String?) -> String? {
    guard let s = sealed, let d = open(token, s) else { return nil }
    return String(data: d, encoding: .utf8)
  }

  static func sealedSize(_ size: Int64) -> Int64 {
    Int64(saltLen) + size + Int64(tag) * (size == 0 ? 1 : (size + Int64(ch) - 1) / Int64(ch))
  }

  private static func nonce(_ salt: Data, _ i: UInt32, _ last: Bool) -> AES.GCM.Nonce {
    var n = Data(salt.prefix(saltLen))
    n.append(last ? 1 : 0)
    n.append(contentsOf: [UInt8(i >> 24 & 0xff), UInt8(i >> 16 & 0xff), UInt8(i >> 8 & 0xff), UInt8(i & 0xff)])
    return try! AES.GCM.Nonce(data: n)
  }

  enum Failure: Error { case cut, changed, bad }

  // `seed` picks the salt, so sealing the same file for the same upload id gives the same bytes and
  // a retry can carry on from what the other side already has
  static func sealFile(_ token: String, from src: URL, to dst: URL, seed: String) throws {
    let k = keys(token)
    let size = (try FileManager.default.attributesOfItem(atPath: src.path)[.size] as? NSNumber)?.int64Value ?? 0
    let input = try FileHandle(forReadingFrom: src)
    defer { try? input.close() }
    FileManager.default.createFile(atPath: dst.path, contents: nil)
    let out = try FileHandle(forWritingTo: dst)
    defer { try? out.close() }
    let salt = mac(k, Data("up\0\(seed)".utf8)).prefix(saltLen)
    try out.write(contentsOf: salt)
    let n = size == 0 ? 1 : (size + Int64(ch) - 1) / Int64(ch)
    for i in 0..<n {
      let want = Int(min(Int64(ch), size - i * Int64(ch)))
      let plain = try input.read(upToCount: want) ?? Data()
      if plain.count != want { throw Failure.changed }
      let box = try AES.GCM.seal(plain, using: k.enc, nonce: nonce(salt, UInt32(i), i == n - 1))
      try out.write(contentsOf: box.ciphertext + box.tag)
    }
  }

  // the file back out of a sealed one; throws on anything tampered with, reordered or cut short
  static func openFile(_ token: String, from src: URL, to dst: URL) throws {
    let enc = keys(token).enc
    let input = try FileHandle(forReadingFrom: src)
    defer { try? input.close() }
    FileManager.default.createFile(atPath: dst.path, contents: nil)
    let out = try FileHandle(forWritingTo: dst)
    defer { try? out.close() }
    let salt = try input.read(upToCount: saltLen) ?? Data()
    if salt.count != saltLen { throw Failure.cut }
    var cur = try input.read(upToCount: ch + tag) ?? Data()
    var i: UInt32 = 0
    while true {
      // a full chunk with more after it isn't the last one
      let next = cur.count == ch + tag ? (try input.read(upToCount: ch + tag) ?? Data()) : Data()
      let last = next.isEmpty
      if cur.count < tag { throw Failure.cut }
      let box = try AES.GCM.SealedBox(nonce: nonce(salt, i, last), ciphertext: cur.prefix(cur.count - tag), tag: cur.suffix(tag))
      try out.write(contentsOf: try AES.GCM.open(box, using: enc))
      if last { return }
      i += 1
      cur = next
    }
  }

  // phone pairing: each side makes a key, swaps the public half, and both end up with the same
  // secret and the same 6-digit code to compare on screen
  final class Pairing {
    private let key = P256.KeyAgreement.PrivateKey()
    var pub: String { Seal.b64(key.publicKey.x963Representation) }

    func finish(_ theirPub: String) throws -> (secret: String, code: String) {
      guard let b = Seal.unb64(theirPub), let them = try? P256.KeyAgreement.PublicKey(x963Representation: b) else { throw Failure.bad }
      let z = try key.sharedSecretFromKeyAgreement(with: them).withUnsafeBytes { Data($0) }
      let secret = Seal.hex(Seal.hmac(Data("fshare-pair-1".utf8), z))
      let h = Seal.mac(Seal.keys(secret), Data("code".utf8))
      let n = UInt32(h[0]) << 24 | UInt32(h[1]) << 16 | UInt32(h[2]) << 8 | UInt32(h[3])
      return (secret, String(format: "%06u", n % 1_000_000))
    }
  }
}
