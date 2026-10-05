package expo.modules.fsharepeer

import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

// Phone-to-phone: a small fshare server on this phone, Wi-Fi discovery, and the USB-C cable link.
class FsharePeerModule : Module() {
  private var server: PeerServer? = null
  private var nearby: Nearby? = null
  private var tunnel: UsbTunnel? = null
  private var me: Triple<String, String, Boolean>? = null
  private var pairing: Seal.Pairing? = null

  private val context get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FsharePeer")
    Events("pairRequest", "progress", "received", "stopped", "peerFound", "peerLost", "usb")

    // "Ashish's S23" as set in Settings › About phone, else the model
    Function("deviceName") {
      Settings.Global.getString(context.contentResolver, "device_name")?.takeIf { it.isNotBlank() } ?: Build.MODEL
    }

    // idempotent: a JS reload calls it again
    Function("start") { token: String, name: String, id: String, visible: Boolean ->
      if (server != null) return@Function
      val emit: Emit = { event, body -> sendEvent(event, body) }
      me = Triple(name, id, visible)
      server = PeerServer(SERVER_PORT, token, name, File(context.cacheDir, "fshare-in"), emit).also { it.visible = visible; it.start() }
      nearby = Nearby(context, emit).also { it.announce(name, SERVER_PORT, id, !visible); it.discover() }
      tunnel = UsbTunnel(context, CABLE_PORT, SERVER_PORT, emit).also { it.start() }
    }

    // re-announce with the new hidden flag; NSD can't change a registered service's attributes
    Function("setVisible") { visible: Boolean ->
      val (name, id) = me ?: return@Function
      me = Triple(name, id, visible)
      server?.visible = visible
      nearby?.run { unannounce(); announce(name, SERVER_PORT, id, !visible) }
    }

    // on: start or update the ongoing "keep running" notification; off: stop it
    Function("background") { on: Boolean, title: String, text: String, progress: Int ->
      if (on) TransferService.show(context, title, text, progress) else TransferService.hide(context)
    }

    // end-to-end encryption (Seal.kt): the app signs its requests and seals/opens what it sends
    Function("sign") { token: String, msg: String -> Seal.sign(token, msg) }
    Function("seal") { token: String, text: String -> Seal.seal(token, text.toByteArray()) }
    Function("open") { token: String, sealed: String -> Seal.openText(token, sealed) }
    AsyncFunction("sealFile") { token: String, src: String, dst: String, seed: String ->
      val from = File(Uri.parse(src).path!!)
      File(Uri.parse(dst).path!!).outputStream().buffered(1 shl 18).use { out ->
        from.inputStream().buffered(1 shl 18).use { Seal.sealFile(token, it, from.length(), out, seed) }
      }
      Seal.sealedSize(from.length()).toDouble()
    }
    AsyncFunction("openFile") { token: String, src: String, dst: String ->
      val to = File(Uri.parse(dst).path!!)
      try {
        to.outputStream().buffered(1 shl 18).use { out ->
          File(Uri.parse(src).path!!).inputStream().buffered(1 shl 18).use { Seal.openFile(token, it, out) }
        }.toDouble()
      } catch (e: Exception) {
        to.delete()
        throw e
      }
    }
    // pairing with another phone: pairStart() gives our public key, pairFinish(theirs) the shared
    // secret and the code both screens show
    Function("pairStart") { Seal.Pairing().also { pairing = it }.pub }
    Function("pairFinish") { theirPub: String ->
      val (secret, code) = (pairing ?: throw IllegalStateException("pairStart first")).finish(theirPub)
      pairing = null
      mapOf("secret" to secret, "code" to code)
    }

    Function("answerPair") { id: String, ok: Boolean -> server?.answer(id, ok) }
    Function("cancel") { id: String -> server?.cancel(id) }

    OnDestroy {
      server?.stop(); nearby?.stop(); tunnel?.stop()
      TransferService.hide(context)
      server = null; nearby = null; tunnel = null
    }
  }

  companion object {
    const val SERVER_PORT = 4748 // this phone's server (Wi-Fi peers connect here)
    const val CABLE_PORT = 4749 // 127.0.0.1 port that reaches the other phone over USB
  }
}
