import ExpoModulesCore

// Phone-to-phone on iPhone: a small fshare server and Bonjour discovery, over Wi-Fi only
// (iOS gives apps no USB link to another phone).
public class FsharePeerModule: Module {
  private var server: PeerServer?
  private var nearby: Nearby?

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
    Function("answerPair") { (id: String, ok: Bool) in self.server?.answer(id, ok) }
    Function("cancel") { (id: String) in self.server?.cancel(id) }

    OnDestroy {
      self.server?.stop()
      self.nearby?.stop()
      self.server = nil
      self.nearby = nil
    }
  }
}
