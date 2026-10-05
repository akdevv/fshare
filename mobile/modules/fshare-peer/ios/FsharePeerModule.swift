import ExpoModulesCore
import UIKit

// Phone-to-phone on iPhone: a small fshare server and Bonjour discovery, over Wi-Fi only
// (iOS gives apps no USB link to another phone).
public class FsharePeerModule: Module {
  private var server: PeerServer?
  private var nearby: Nearby?
  private var task: UIBackgroundTaskIdentifier = .invalid
  private var pairing: Seal.Pairing?

  public func definition() -> ModuleDefinition {
    Name("FsharePeer")
    Events("pairRequest", "progress", "received", "stopped", "peerFound", "peerLost", "usb")

    // null: JS falls back to expo-constants, which reads the same UIDevice name
    Function("deviceName") { () -> String? in nil }

    // idempotent: a JS reload calls it again
    Function("start") { (token: String, name: String, id: String, visible: Bool) in
      if self.server != nil { return }
      let emit: Emit = { [weak self] event, body in self?.sendEvent(event, body) }
      let parts = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("fshare-in")
      self.server = PeerServer(port: 4748, token: token, name: name, id: id, visible: visible, parts: parts, emit: emit)
      self.server?.start()
      self.nearby = Nearby(emit: emit)
      self.nearby?.discover()
    }

    Function("setVisible") { (visible: Bool) in self.server?.setVisible(visible) }
    // iOS has no long-running service: while files move, ask for background time (a few minutes at most)
    Function("background") { (on: Bool, _: String, _: String, _: Int) in
      DispatchQueue.main.async {
        if on, self.task == .invalid {
          self.task = UIApplication.shared.beginBackgroundTask(withName: "fshare transfer") { self.endTask() }
        } else if !on {
          self.endTask()
        }
      }
    }

    // end-to-end encryption (Seal.swift): the app signs its requests and seals/opens what it sends
    Function("sign") { (token: String, msg: String) in Seal.sign(token, msg) }
    Function("seal") { (token: String, text: String) in Seal.seal(token, Data(text.utf8)) }
    Function("open") { (token: String, sealed: String) -> String? in Seal.openText(token, sealed) }
    AsyncFunction("sealFile") { (token: String, src: URL, dst: URL, seed: String) -> Double in
      try Seal.sealFile(token, from: src, to: dst, seed: seed)
      let size = (try FileManager.default.attributesOfItem(atPath: src.path)[.size] as? NSNumber)?.int64Value ?? 0
      return Double(Seal.sealedSize(size))
    }
    AsyncFunction("openFile") { (token: String, src: URL, dst: URL) -> Double in
      do {
        try Seal.openFile(token, from: src, to: dst)
      } catch {
        try? FileManager.default.removeItem(at: dst)
        throw error
      }
      return (try FileManager.default.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.doubleValue ?? 0
    }
    // pairing with another phone: pairStart() gives our public key, pairFinish(theirs) the shared
    // secret and the code both screens show
    Function("pairStart") { () -> String in
      let p = Seal.Pairing()
      self.pairing = p
      return p.pub
    }
    Function("pairFinish") { (theirPub: String) -> [String: String] in
      guard let p = self.pairing else { throw Seal.Failure.bad }
      self.pairing = nil
      let (secret, code) = try p.finish(theirPub)
      return ["secret": secret, "code": code]
    }

    Function("answerPair") { (id: String, ok: Bool) in self.server?.answer(id, ok) }
    Function("cancel") { (id: String) in self.server?.cancel(id) }

    OnDestroy {
      self.server?.stop()
      self.nearby?.stop()
      self.server = nil
      self.nearby = nil
      DispatchQueue.main.async { self.endTask() }
    }
  }

  private func endTask() {
    guard task != .invalid else { return }
    UIApplication.shared.endBackgroundTask(task)
    task = .invalid
  }
}
