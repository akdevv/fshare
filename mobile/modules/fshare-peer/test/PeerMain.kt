// Runs the app's Android peer server on a plain JVM for drive.mts (stubs/ stands in for android.*).
// Before serving it opens the file Node sealed, and seals one for Node, so both directions of the
// app's file sealing get checked too.
import expo.modules.fsharepeer.PeerServer
import expo.modules.fsharepeer.Seal
import org.json.JSONObject
import java.io.File

fun main(args: Array<String>) {
  val dir = File(args[0])
  val plain = File(dir, "plain.bin")
  File(dir, "native.out").outputStream().use { Seal.openFile("ptok", File(dir, "node.sealed").inputStream().buffered(), it) }
  File(dir, "native.sealed").outputStream().use { Seal.sealFile("ptok", plain.inputStream(), plain.length(), it, "job1") }
  lateinit var server: PeerServer
  server = PeerServer(args[1].toInt(), "ptok", "Test phone", File(dir, "parts")) { event, body ->
    println(JSONObject(body + ("event" to event)).toString())
    System.out.flush()
    if (event == "pairRequest") server.answer(body["id"] as String, true)
  }
  server.start()
  println("""{"event":"ready"}""")
  System.out.flush()
  Thread.currentThread().join()
}
