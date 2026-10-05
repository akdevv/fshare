package expo.modules.fsharepeer

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import java.net.Inet4Address
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

// Finds other phones running fshare on the same Wi-Fi or hotspot (mDNS / DNS-SD, like AirDrop's
// Bonjour), and announces this one.
class Nearby(context: Context, private val emit: Emit) {
  private val nsd = context.getSystemService(NsdManager::class.java)
  private val type = "_fshare._tcp"
  private var registration: NsdManager.RegistrationListener? = null
  private var discovery: NsdManager.DiscoveryListener? = null
  // older Androids resolve one service at a time, so resolves queue up here
  private val resolver = Executors.newSingleThreadExecutor()

  fun announce(name: String, port: Int, id: String) {
    if (registration != null) return
    val info = NsdServiceInfo().apply {
      serviceName = name
      serviceType = type
      this.port = port
      setAttribute("id", id)
    }
    registration = object : NsdManager.RegistrationListener {
      override fun onServiceRegistered(info: NsdServiceInfo) {}
      override fun onRegistrationFailed(info: NsdServiceInfo, code: Int) { registration = null }
      override fun onServiceUnregistered(info: NsdServiceInfo) {}
      override fun onUnregistrationFailed(info: NsdServiceInfo, code: Int) {}
    }
    nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registration)
  }

  fun discover() {
    if (discovery != null) return
    discovery = object : NsdManager.DiscoveryListener {
      override fun onDiscoveryStarted(type: String) {}
      override fun onDiscoveryStopped(type: String) {}
      override fun onStartDiscoveryFailed(type: String, code: Int) { discovery = null }
      override fun onStopDiscoveryFailed(type: String, code: Int) {}
      override fun onServiceFound(info: NsdServiceInfo) { resolver.execute { resolve(info) } }
      override fun onServiceLost(info: NsdServiceInfo) { emit("peerLost", mapOf("name" to info.serviceName)) }
    }
    nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, discovery)
  }

  @Suppress("DEPRECATION")
  private fun resolve(service: NsdServiceInfo) {
    val done = Semaphore(0)
    nsd.resolveService(service, object : NsdManager.ResolveListener {
      override fun onResolveFailed(info: NsdServiceInfo, code: Int) { done.release() }
      override fun onServiceResolved(info: NsdServiceInfo) {
        val host = if (Build.VERSION.SDK_INT >= 34) info.hostAddresses.firstOrNull { it is Inet4Address } ?: info.hostAddresses.firstOrNull()
          else info.host
        if (host != null) emit("peerFound", mapOf(
          "name" to info.serviceName, "host" to host.hostAddress, "port" to info.port,
          "id" to (info.attributes["id"]?.let { String(it) } ?: ""),
        ))
        done.release()
      }
    })
    done.tryAcquire(10, TimeUnit.SECONDS)
  }

  fun stop() {
    registration?.let { try { nsd.unregisterService(it) } catch (_: Exception) {} }
    discovery?.let { try { nsd.stopServiceDiscovery(it) } catch (_: Exception) {} }
    registration = null
    discovery = null
  }
}
