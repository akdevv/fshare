package expo.modules.fsharepeer

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.hardware.usb.UsbConstants
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbEndpoint
import android.hardware.usb.UsbManager
import android.os.ParcelFileDescriptor
import java.io.DataInputStream
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

// Phone-to-phone over a USB-C cable, the way `adb reverse` works for the laptop:
// each phone listens on 127.0.0.1:listenPort, and every connection made there is carried over
// the cable to the other phone's fshare server (127.0.0.1:targetPort there). The app then talks
// to the other phone exactly like it talks to the laptop over USB.
//
// The cable makes one phone the USB host. The host switches the other phone into Android Open
// Accessory mode (AOA), after which both sides get a raw bulk pipe. Connections are multiplexed
// over it with 9-byte frames: [type:1][conn:4][len:4][payload].
// ponytail: no per-connection flow control; one slow socket stalls the pipe. Fine for one app talking to one peer.
class UsbTunnel(private val context: Context, private val listenPort: Int, private val targetPort: Int, private val emit: Emit) {
  private interface Link { fun read(buf: ByteArray): Int; fun write(buf: ByteArray, len: Int); fun close() }

  private val usb = context.getSystemService(UsbManager::class.java)
  private val asked = HashSet<String>() // devices we already asked the user about (one prompt per plug-in)
  private val tried = HashSet<String>() // devices that aren't phones / didn't speak AOA
  private val seen = HashMap<String, Long>() // when each AOA device first showed up
  @Volatile private var link: Link? = null
  @Volatile private var running = false
  private var listener: ServerSocket? = null
  private val conns = ConcurrentHashMap<Int, Socket>()
  private val nextId = AtomicInteger(1)
  private var side = 0 // low bit of connection ids we open: 0 on the host, 1 on the accessory
  private val writeLock = Any()

  // Unplugged: let go of the link at once. A read on the accessory can block on after the cable
  // is gone, and while we hold /dev/usb_accessory, Android can't start the next accessory session
  // ("could not open /dev/usb_accessory"): every later plug-in silently fails until the app dies.
  private val detached = object : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) { teardown() }
  }

  fun start() {
    if (running) return
    running = true
    val filter = IntentFilter().apply {
      addAction(UsbManager.ACTION_USB_ACCESSORY_DETACHED)
      addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
    }
    if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(detached, filter, Context.RECEIVER_EXPORTED)
    else context.registerReceiver(detached, filter)
    thread(isDaemon = true, name = "fshare-usb") {
      while (running) {
        if (link == null) try { connect() } catch (_: Exception) {}
        // the broadcast can be missed (e.g. while the app was frozen): check by hand too
        else if (side == 1 && usb.accessoryList?.any { it.manufacturer == "akdevv" && it.model == "fshare" } != true) teardown()
        Thread.sleep(1000)
      }
    }
  }

  fun stop() {
    running = false
    try { context.unregisterReceiver(detached) } catch (_: Exception) {}
    teardown()
  }

  private fun permission(onGranted: () -> Unit, has: Boolean, key: String, request: (PendingIntent) -> Unit) {
    if (has) return onGranted()
    if (!asked.add(key)) return
    val intent = Intent("dev.akdevv.fshare.USB_PERMISSION").setPackage(context.packageName)
    request(PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_MUTABLE))
  }

  private fun connect() {
    if (usb.accessoryList.isNullOrEmpty()) asked.remove("acc") // a new accessory session may ask again
    // we are the accessory: the other phone already switched us
    usb.accessoryList?.firstOrNull { it.manufacturer == "akdevv" && it.model == "fshare" }?.let { acc ->
      permission({ openAccessory(usb.openAccessory(acc)) }, usb.hasPermission(acc), "acc") { usb.requestPermission(acc, it) }
      return
    }
    val present = usb.deviceList.values
    asked.retainAll(present.map { it.deviceName }.toSet() + "acc")
    tried.retainAll(present.map { it.deviceName }.toSet())
    seen.keys.retainAll(present.map { it.deviceName }.toSet())
    for (d in present) {
      if (d.deviceName in tried) continue
      if (d.vendorId == 0x18D1 && d.productId in 0x2D00..0x2D05) {
        // Android itself offers "Open fshare?" for this one (manifest filter), which grants access;
        // give the user a moment to answer that before asking a second time ourselves
        val first = seen.getOrPut(d.deviceName) { System.currentTimeMillis() }
        if (!usb.hasPermission(d) && System.currentTimeMillis() - first < 5000) return
        permission({ openHost(d) }, usb.hasPermission(d), d.deviceName) { usb.requestPermission(d, it) }
        return
      }
      if (!maybePhone(d)) { tried.add(d.deviceName); continue }
      permission({ switchToAccessory(d) }, usb.hasPermission(d), d.deviceName) { usb.requestPermission(d, it) }
    }
    if (present.isEmpty()) asked.remove("acc")
  }

  // keyboards, hubs, card readers, headsets: never ask the user about those
  private fun maybePhone(d: UsbDevice): Boolean {
    val skip = setOf(UsbConstants.USB_CLASS_HID, UsbConstants.USB_CLASS_HUB, UsbConstants.USB_CLASS_MASS_STORAGE,
      UsbConstants.USB_CLASS_AUDIO, UsbConstants.USB_CLASS_VIDEO, UsbConstants.USB_CLASS_WIRELESS_CONTROLLER)
    return (0 until d.interfaceCount).none { d.getInterface(it).interfaceClass in skip }
  }

  private fun switchToAccessory(d: UsbDevice) {
    tried.add(d.deviceName)
    val c = usb.openDevice(d) ?: return
    try {
      val v = ByteArray(2)
      if (c.controlTransfer(0xC0, 51, 0, 0, v, 2, 1000) != 2 || (v[0].toInt() or (v[1].toInt() shl 8)) < 1) return
      listOf("akdevv", "fshare", "fshare phone link", "1", "https://github.com/akdevv", "fshare").forEachIndexed { i, s ->
        val b = (s + "\u0000").toByteArray()
        c.controlTransfer(0x40, 52, 0, i, b, b.size, 1000)
      }
      c.controlTransfer(0x40, 53, 0, 0, null, 0, 1000) // the phone re-appears with Google's AOA ids
    } finally { c.close() }
  }

  private fun openHost(d: UsbDevice) {
    val c: UsbDeviceConnection = usb.openDevice(d) ?: return
    val iface = d.getInterface(0)
    if (!c.claimInterface(iface, true)) { c.close(); return }
    var epIn: UsbEndpoint? = null
    var epOut: UsbEndpoint? = null
    for (i in 0 until iface.endpointCount) {
      val e = iface.getEndpoint(i)
      if (e.type != UsbConstants.USB_ENDPOINT_XFER_BULK) continue
      if (e.direction == UsbConstants.USB_DIR_IN) epIn = e else epOut = e
    }
    if (epIn == null || epOut == null) { c.close(); return }
    val inEp = epIn
    val outEp = epOut
    side = 0
    begin(object : Link {
      override fun read(buf: ByteArray): Int {
        while (true) { val n = c.bulkTransfer(inEp, buf, FRAME, 0); if (n != 0) return n } // 0 = zero-length packet
      }
      override fun write(buf: ByteArray, len: Int) {
        // a transfer that's a whole number of packets has no end marker, and the accessory's
        // read would wait for more; split off the last byte so it always ends on a short packet
        if (len % outEp.maxPacketSize == 0 && len < FRAME) {
          send(buf, len - 1)
          send(byteArrayOf(buf[len - 1]), 1)
        } else send(buf, len)
      }
      private fun send(b: ByteArray, n: Int) { if (c.bulkTransfer(outEp, b, n, 5000) != n) throw IOException("usb write") }
      override fun close() { c.releaseInterface(iface); c.close() }
    })
  }

  private fun openAccessory(pfd: ParcelFileDescriptor?) {
    pfd ?: return
    val input = FileInputStream(pfd.fileDescriptor)
    val output = FileOutputStream(pfd.fileDescriptor)
    side = 1
    begin(object : Link {
      // must ask for a full 16 KB. Nothing read means the cable is gone: don't spin on it holding the fd
      override fun read(buf: ByteArray) = input.read(buf, 0, FRAME).let { if (it <= 0) -1 else it }
      override fun write(buf: ByteArray, len: Int) = output.write(buf, 0, len)
      override fun close() { pfd.close() }
    })
  }

  // 127.0.0.1, not getLoopbackAddress(): that's ::1 on some phones (a Galaxy S23 on Android 16),
  // and the app connects to 127.0.0.1, so the cable link was up but never found
  private fun begin(l: Link) {
    val ss = try { ServerSocket().apply { reuseAddress = true; bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), listenPort)) } }
      catch (e: IOException) { l.close(); throw e }
    listener = ss
    link = l
    emit("usb", mapOf("state" to "connected", "role" to if (side == 0) "host" else "accessory"))
    thread(isDaemon = true, name = "fshare-usb-accept") {
      while (!ss.isClosed) {
        val s = try { ss.accept() } catch (_: IOException) { break }
        val id = (nextId.getAndIncrement() shl 1) or side
        conns[id] = s
        try { frame(OPEN, id, null, 0) } catch (_: IOException) { s.close(); break }
        pump(id, s)
      }
    }
    thread(isDaemon = true, name = "fshare-usb-read") {
      try { readLoop(l) } catch (_: Exception) {}
      teardown()
    }
  }

  private fun readLoop(l: Link) {
    val chunk = ByteArray(FRAME)
    val src = object : InputStream() {
      var pos = 0
      var end = 0
      override fun read(): Int { if (!fill()) return -1; return chunk[pos++].toInt() and 0xff }
      override fun read(b: ByteArray, off: Int, len: Int): Int {
        if (!fill()) return -1
        val n = minOf(len, end - pos)
        System.arraycopy(chunk, pos, b, off, n)
        pos += n
        return n
      }
      private fun fill(): Boolean {
        if (pos < end) return true
        val n = l.read(chunk)
        if (n < 0) return false
        pos = 0; end = n
        return true
      }
    }
    val r = DataInputStream(src)
    val payload = ByteArray(FRAME)
    while (true) {
      val type = r.readByte().toInt()
      val id = r.readInt()
      val len = r.readInt()
      if (len < 0 || len > FRAME) throw IOException("bad frame")
      r.readFully(payload, 0, len)
      when (type) {
        OPEN -> {
          val s = try { Socket("127.0.0.1", targetPort).apply { tcpNoDelay = true } } catch (_: IOException) { null }
          if (s == null) frame(CLOSE, id, null, 0) else { conns[id] = s; pump(id, s) }
        }
        DATA -> conns[id]?.let { s ->
          try { s.getOutputStream().write(payload, 0, len) } catch (_: IOException) { conns.remove(id); s.close(); frame(CLOSE, id, null, 0) }
        }
        CLOSE -> conns.remove(id)?.close()
      }
    }
  }

  // socket -> cable
  private fun pump(id: Int, s: Socket) = thread(isDaemon = true) {
    val buf = ByteArray(FRAME - HEADER)
    try {
      val input = s.getInputStream()
      while (true) {
        val n = input.read(buf)
        if (n < 0) break
        frame(DATA, id, buf, n)
      }
    } catch (_: IOException) {}
    if (conns.remove(id) != null) try { frame(CLOSE, id, null, 0) } catch (_: IOException) {}
    s.close()
  }

  private val out = ByteBuffer.allocate(FRAME)
  private fun frame(type: Int, id: Int, data: ByteArray?, len: Int) {
    val l = link ?: throw IOException("no link")
    synchronized(writeLock) {
      out.clear()
      out.put(type.toByte()).putInt(id).putInt(len)
      if (data != null) out.put(data, 0, len)
      l.write(out.array(), HEADER + len)
    }
  }

  @Synchronized // the unplug broadcast and the read thread can both get here
  private fun teardown() {
    val l = link ?: return
    link = null
    try { listener?.close() } catch (_: Exception) {}
    listener = null
    conns.values.forEach { try { it.close() } catch (_: Exception) {} }
    conns.clear()
    try { l.close() } catch (_: Exception) {}
    emit("usb", mapOf("state" to "disconnected"))
  }

  companion object {
    const val FRAME = 16384 // USB accessory transfers are at most 16 KB
    const val HEADER = 9
    const val OPEN = 1
    const val DATA = 2
    const val CLOSE = 3
  }
}
