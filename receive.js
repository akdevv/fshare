const net = require("net"),
  fs = require("fs");

net
  .createServer((socket) => {
    console.log("sender connected!");
    socket.pipe(fs.createWriteStream("received.bin"));
    socket.on("end", () => console.log("done!"));
  })
  .listen(1234, () => console.log("listening on port: 1234"));
