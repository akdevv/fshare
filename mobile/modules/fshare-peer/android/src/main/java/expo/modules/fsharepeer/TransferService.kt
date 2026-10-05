package expo.modules.fsharepeer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

// Keeps fshare alive while it's minimized: a foreground service with one quiet ongoing
// notification ("Connected to …", "Sending 3 files · 45%"). Without it Android freezes the
// app soon after it leaves the screen, and transfers stall.
class TransferService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = build(this, intent?.getStringExtra("title") ?: "fshare", intent?.getStringExtra("text") ?: "", intent?.getIntExtra("progress", -1) ?: -1)
    if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC) else startForeground(ID, n)
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    private const val ID = 4747
    private const val CHANNEL = "fshare-transfers"
    @Volatile private var running = false

    // start, or update the notification of the running service
    fun show(context: Context, title: String, text: String, progress: Int) {
      if (running) {
        context.getSystemService(NotificationManager::class.java).notify(ID, build(context, title, text, progress))
        return
      }
      val intent = Intent(context, TransferService::class.java)
        .putExtra("title", title).putExtra("text", text).putExtra("progress", progress)
      try {
        if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
        running = true
      } catch (_: Exception) {
        // Android 12+ refuses to start one from the background; the next call from the foreground will
      }
    }

    fun hide(context: Context) {
      if (!running) return
      context.stopService(Intent(context, TransferService::class.java))
      running = false
    }

    private fun build(context: Context, title: String, text: String, progress: Int): Notification {
      val nm = context.getSystemService(NotificationManager::class.java)
      if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null) {
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Transfers", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shows while fshare is sending or receiving files"
          setShowBadge(false)
        })
      }
      val open = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
        PendingIntent.getActivity(context, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      }
      @Suppress("DEPRECATION")
      val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
      b.setSmallIcon(if (progress >= 0) android.R.drawable.stat_sys_upload else android.R.drawable.stat_notify_sync_noanim)
        .setContentTitle(title)
        .setContentText(text)
        .setOngoing(true)
        .setOnlyAlertOnce(true)
        .setContentIntent(open)
      if (progress >= 0) b.setProgress(100, progress, false)
      if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
      return b.build()
    }
  }
}
