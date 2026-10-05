package expo.modules.fsharepeer

import android.net.Uri
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

typealias Emit = (String, Map<String, Any?>) -> Unit

const val KEEP_MS = 5 * 60_000L // how long a half-received file waits for the sender to resume

// The receiving half of fshare on a phone. Speaks the same HTTP as the laptop CLI, so the
// app's upload code (resumable PUT /upload) works phone-to-phone unchanged. Every request but
// /pair and /hello is signed with this phone's token, and everything is sealed (see Seal.kt):
//   GET  /pair                    token, loopback only (i.e. through the USB cable tunnel)
//   POST /hello?name=&port=&id=&pub=   Wi-Fi pairing, step 1: swap ECDH keys, get a request id
//   POST /hello?wait=&token=           step 2: our user compares the code and accepts; returns our token, sealed
//   GET  /list                    sealed { name, kind: "phone", files: [] } (phones push, they don't publish)
//   GET|PUT|DELETE /upload?id=    resumable upload of a sealed file; opened, then handed to JS to save
// ponytail: thread per connection; fine for a handful of peers.
class PeerServer(
  private val port: Int,
  private val token: String,
  private val name: String,
  private val partsDir: File,
  private val emit: Emit,
) {
  private var socket: ServerSocket? = null
  private val pairs = ConcurrentHashMap<String, CompletableFuture<Boolean>>()
  private val uploads = ConcurrentHashMap<String, Socket>()
  private val cancelled = ConcurrentHashMap.newKeySet<String>()
  private val finished = ConcurrentHashMap.newKeySet<String>() // saved already: a replay isn't saved twice
  private class Hello(val secret: String, val code: String, val name: String, val port: Int, val peer: String, val at: Long)
  private val hellos = ConcurrentHashMap<String, Hello>() // step 1 done, waiting for step 2
  @Volatile var visible = true // hidden: new phones can't ask to pair; paired ones already have the token

  fun start() {
    partsDir.mkdirs()
    val ss = ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(port)) }
    socket = ss
    thread(isDaemon = true, name = "fshare-server") {
      while (!ss.isClosed) {
        val s = try { ss.accept() } catch (e: IOException) { break }
        thread(isDaemon = true) { try { serve(s) } catch (_: Exception) {} finally { s.close() } }
      }
    }
    thread(isDaemon = true, name = "fshare-sweep") {
      while (!ss.isClosed) { sweep(); try { Thread.sleep(60_000) } catch (_: InterruptedException) { break } }
    }
  }

  // A stopped upload's part waits KEEP_MS for the sender to retry and pick up where it left off
  // (even across an app restart: parts live in the cache dir). Older ones are dropped.
  private fun sweep() {
    val now = System.currentTimeMillis()
    val busy = uploads.keys.map { part(it).name }.toSet()
    partsDir.listFiles()?.forEach { f ->
      if (f.name !in busy && now - f.lastModified() > KEEP_MS && f.delete()) {
        emit("stopped", mapOf("id" to f.name, "reason" to "expired"))
      }
    }
  }

  fun stop() {
    socket?.close()
    uploads.values.forEach { it.close() }
    pairs.values.forEach { it.complete(false) }
  }

  fun answer(id: String, ok: Boolean) { pairs[id]?.complete(ok) }

  // receiver taps cancel: drop the connection (the sender sees it fail) and the partial file
  fun cancel(id: String) {
    cancelled.add(id)
    uploads[id]?.close() ?: part(id).delete()
  }

  private fun part(id: String) = File(partsDir, id.replace(Regex("[^\\w-]"), "").take(80).ifEmpty { "x" })

  private fun serve(s: Socket) {
    s.tcpNoDelay = true
    val input = BufferedInputStream(s.getInputStream(), 1 shl 16)
    val out = s.getOutputStream()
    while (true) { // keep-alive: OkHttp reuses connections
      val line = readLine(input) ?: return
      if (line.isEmpty()) continue
      val parts = line.split(" ")
      val method = parts[0]
      val headers = HashMap<String, String>()
      while (true) {
        val h = readLine(input) ?: return
        if (h.isEmpty()) break
        val i = h.indexOf(':')
        if (i > 0) headers[h.substring(0, i).trim().lowercase()] = h.substring(i + 1).trim()
      }
      val uri = Uri.parse("http://x${parts.getOrElse(1) { "/" }}")
      val length = headers["content-length"]?.toLongOrNull() ?: 0L
      if (!route(s, method, parts.getOrElse(1) { "/" }, uri, headers, length, input, out)) return
    }
  }

  // returns false when the connection can't be reused
  private fun route(s: Socket, method: String, target: String, uri: Uri, headers: Map<String, String>, length: Long, input: InputStream, out: OutputStream): Boolean {
    val path = uri.path ?: "/"
    val q = { k: String -> uri.getQueryParameter(k) }

    if (path == "/pair") {
      skip(input, length)
      return if (s.inetAddress.isLoopbackAddress) respond(out, 200, token) else respond(out, 403, "")
    }

    if (path == "/hello" && method == "POST") {
      skip(input, length)
      if (!visible) return respond(out, 403, "hidden")
      val now = System.currentTimeMillis()
      hellos.values.removeIf { now - it.at > 120_000 }
      val wait = q("wait")
      if (wait == null) {
        // step 1: both sides now share a secret nobody on the Wi-Fi can work out
        val pairing = Seal.Pairing()
        val (secret, code) = try { pairing.finish(q("pub") ?: "") } catch (_: Exception) { return respond(out, 400, "bad key") }
        val id = UUID.randomUUID().toString()
        hellos[id] = Hello(secret, code, q("name") ?: "Phone", q("port")?.toIntOrNull() ?: 0, q("id") ?: "", now)
        return respond(out, 200, JSONObject(mapOf("id" to id, "pub" to pairing.pub)).toString(), "application/json")
      }
      // step 2: their token, sealed with the secret; ask our user, who checks the code matches theirs
      val h = hellos.remove(wait) ?: return respond(out, 403, "expired")
      val theirs = Seal.openText(h.secret, q("token")) ?: return respond(out, 403, "bad token")
      val answer = CompletableFuture<Boolean>()
      pairs[wait] = answer
      emit("pairRequest", mapOf(
        "id" to wait, "name" to h.name, "host" to s.inetAddress.hostAddress, "port" to h.port,
        "token" to theirs, "peer" to h.peer, "code" to h.code,
      ))
      val ok = try { answer.get(60, TimeUnit.SECONDS) } catch (_: Exception) { false }
      pairs.remove(wait)
      return if (ok) respond(out, 200, Seal.seal(h.secret, token.toByteArray())) else respond(out, 403, "declined")
    }

    if (!Seal.verify(token, method, target)) { skip(input, length); return respond(out, 403, "bad signature") }

    if (method == "GET" && path == "/list") {
      val list = JSONObject(mapOf("name" to name, "kind" to "phone", "files" to org.json.JSONArray()))
      return respond(out, 200, Seal.seal(token, list.toString().toByteArray()))
    }

    val id = if (path == "/upload") q("id") else null
    if (id != null && method == "GET") return respond(out, 200, """{"received":${part(id).length()}}""", "application/json")
    if (id != null && method == "DELETE") {
      skip(input, length)
      part(id).delete()
      emit("stopped", mapOf("id" to id, "reason" to "cancelled"))
      return respond(out, 200, "ok")
    }
    if (id != null && method == "PUT") return upload(s, id, q, headers, length, input, out)

    skip(input, length)
    return respond(out, 404, "")
  }

  private fun upload(s: Socket, id: String, q: (String) -> String?, headers: Map<String, String>, length: Long, input: InputStream, out: OutputStream): Boolean {
    val name = (Seal.openText(token, q("name")) ?: "").substringAfterLast('/').trim()
    val offset = q("offset")?.toLongOrNull() ?: 0L
    val size = q("size")?.toLongOrNull() ?: length
    val f = part(id)
    if (name.isEmpty() || name == "." || name == "..") { skip(input, length); return respond(out, 400, "bad name") }
    if (id in finished) { skip(input, length); return respond(out, 200, "ok") }
    if (offset > f.length()) { skip(input, length); return respond(out, 409, """{"received":${f.length()}}""", "application/json") }
    cancelled.remove(id)
    uploads[id] = s
    val from = Seal.openText(token, headers["x-fshare-client"]) ?: "Phone"
    val info = { done: Long -> mapOf("id" to id, "name" to name, "from" to from, "done" to done.toDouble(), "total" to size.toDouble()) }
    var done = offset
    emit("progress", info(done))
    try {
      RandomAccessFile(f, "rw").use { raf ->
        raf.setLength(offset)
        raf.seek(offset)
        val buf = ByteArray(1 shl 18)
        var left = length
        var last = 0L
        while (left > 0) {
          val n = input.read(buf, 0, minOf(buf.size.toLong(), left).toInt())
          if (n < 0) throw IOException("closed")
          raf.write(buf, 0, n)
          left -= n
          done += n
          val now = System.currentTimeMillis()
          if (now - last >= 250) { last = now; emit("progress", info(done)) }
        }
      }
    } catch (e: IOException) {
      uploads.remove(id)
      if (cancelled.remove(id)) { f.delete(); emit("stopped", mapOf("id" to id, "reason" to "cancelled")) }
      else emit("stopped", mapOf("id" to id, "reason" to "paused", "done" to f.length().toDouble()))
      return false
    }
    uploads.remove(id)
    if (f.length() != size) return respond(out, 400, "incomplete")
    finished.add(id)
    respond(out, 200, "ok") // all here; opening it can take a while for a big file, so don't keep the sender waiting
    emit("progress", info(size))
    val plain = File(partsDir, "${f.name}.open")
    try {
      plain.outputStream().buffered(1 shl 18).use { o -> f.inputStream().buffered(1 shl 18).use { Seal.openFile(token, it, o) } }
    } catch (e: Exception) {
      // didn't open: not sealed with our token, or damaged on the way. Keep nothing.
      plain.delete(); f.delete()
      emit("stopped", mapOf("id" to id, "reason" to "cancelled"))
      return true
    }
    f.delete()
    emit("received", mapOf("id" to id, "name" to name, "from" to from, "uri" to Uri.fromFile(plain).toString(), "size" to plain.length().toDouble()))
    return true
  }

  private fun respond(out: OutputStream, code: Int, body: String, type: String = "text/plain"): Boolean {
    val bytes = body.toByteArray()
    val reason = mapOf(200 to "OK", 400 to "Bad Request", 403 to "Forbidden", 404 to "Not Found", 409 to "Conflict")[code] ?: "OK"
    val head = "HTTP/1.1 $code $reason\r\n" +
      "Content-Type: $type\r\nContent-Length: ${bytes.size}\r\n" +
      "x-fshare-version: 3\r\nConnection: keep-alive\r\n\r\n"
    out.write(head.toByteArray() + bytes)
    out.flush()
    return true
  }

  private fun skip(input: InputStream, n: Long) {
    var left = n
    while (left > 0) { val k = input.skip(left); if (k <= 0) { if (input.read() < 0) return; left-- } else left -= k }
  }

  private fun readLine(input: InputStream): String? {
    val sb = StringBuilder()
    while (true) {
      val b = input.read()
      if (b < 0) return if (sb.isEmpty()) null else sb.toString()
      if (b == '\n'.code) return sb.toString().trimEnd('\r')
      if (sb.length > 8192) throw IOException("header too long")
      sb.append(b.toChar())
    }
  }
}
