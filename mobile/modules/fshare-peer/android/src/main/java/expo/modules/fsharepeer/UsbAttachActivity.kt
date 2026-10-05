package expo.modules.fsharepeer

import android.app.Activity
import android.os.Bundle

// Target of the USB attach intents. Its only job is to bring the app forward; the tunnel
// itself notices the link by polling UsbManager.
class UsbAttachActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it) }
    finish()
  }
}
