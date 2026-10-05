// Runs the app's iOS peer server on this Mac for drive.mts. Before serving it opens the file Node
// sealed, and seals one for Node, so both directions of the app's file sealing get checked too.
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)
let dir = URL(fileURLWithPath: CommandLine.arguments[1])
try Seal.openFile("ptok", from: dir.appendingPathComponent("node.sealed"), to: dir.appendingPathComponent("native.out"))
try Seal.sealFile("ptok", from: dir.appendingPathComponent("plain.bin"), to: dir.appendingPathComponent("native.sealed"), seed: "job1")
var server: PeerServer!
server = PeerServer(
  port: UInt16(CommandLine.arguments[2])!, token: "ptok", name: "Test phone", id: "test", visible: true,
  parts: dir.appendingPathComponent("parts")
) { event, body in
  var b = body.compactMapValues { $0 }
  b["event"] = event
  print(String(decoding: try! JSONSerialization.data(withJSONObject: b), as: UTF8.self))
  if event == "pairRequest" { server.answer(b["id"] as! String, true) }
}
server.start()
print("{\"event\":\"ready\"}")
dispatchMain()
