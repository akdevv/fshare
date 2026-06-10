const net = require("net"),
  fs = require("fs");

const [, , file, ip] = process.argv;
const socket = net.connect(1234, ip, () => {
  fs.createReadStream(file).pipe(socket);
});

socket.on("close", () => console.log("sent!"));
