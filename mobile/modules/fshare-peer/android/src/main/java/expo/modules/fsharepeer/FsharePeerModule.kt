package expo.modules.fsharepeer

import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException

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
    // renamed in Settings: re-announce under the new name, and answer /list with it
    Function("setName") { name: String ->
      val (_, id, visible) = me ?: return@Function
      me = Triple(name, id, visible)
      server?.name = name
      nearby?.run { unannounce(); announce(name, SERVER_PORT, id, !visible) }
    }

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
    // src can be a Gallery/share content:// URI: read straight from it, no copy first
    AsyncFunction("sealFile") { token: String, src: String, dst: String, seed: String ->
      val u = Uri.parse(src)
      val (size, name) = if (u.scheme == "content") {
        context.contentResolver.query(u, arrayOf(OpenableColumns.SIZE, OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
          if (c.moveToFirst()) Pair(if (c.isNull(0)) -1L else c.getLong(0), c.getString(1)) else null
        } ?: Pair(-1L, null)
      } else File(u.path!!).let { Pair(it.length(), it.name) }
      if (size < 0) throw IOException("size unknown") // the app copies the file in first, then seals that
      val input = if (u.scheme == "content") context.contentResolver.openInputStream(u)!! else File(u.path!!).inputStream()
      File(Uri.parse(dst).path!!).outputStream().buffered(1 shl 18).use { out ->
        input.buffered(1 shl 18).use { Seal.sealFile(token, it, size, out, seed) }
      }
      mapOf("size" to Seal.sealedSize(size).toDouble(), "name" to name)
    }
    // dst can be a content:// file in the save folder: the file is written there directly
    AsyncFunction("openFile") { token: String, src: String, dst: String ->
      val u = Uri.parse(dst)
      val out = if (u.scheme == "content") context.contentResolver.openOutputStream(u, "wt")!! else File(u.path!!).outputStream()
      try {
        out.buffered(1 shl 18).use { o ->
          File(Uri.parse(src).path!!).inputStream().buffered(1 shl 18).use { Seal.openFile(token, it, o) }
        }.toDouble()
      } catch (e: Exception) {
        if (u.scheme != "content") File(u.path!!).delete() // the app deletes a save-folder file itself
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
