# Local File Sharing — MVP Build Plan

**Goal of this phase:** move a file from Mac → Android and Android → Mac over the same WiFi, using the crudest possible code. No QR, no progress bar, no resume, no UI. Just bytes across the wire.

**Definition of done:** a file sent from one device shows up intact on the other, both directions, running on your actual phone and Mac.

---

## Stage 0 — Prove the network path (no code)

The whole "totally local" promise depends on the two devices being able to reach each other over WiFi. Some routers (hostels, offices) have *client isolation* turned on, which silently blocks this. Test it before writing a single line.

- [x] Connect Mac and Android to the **same WiFi network**
- [x] Find the Mac's IP: System Settings → WiFi → Details (looks like `192.168.x.x`)
- [x] On Mac (receiver terminal): `nc -l 1234 > received.bin`
- [x] On the sender: `nc <mac-ip> 1234 < somefile.txt`
- [x] Confirm `received.bin` appears and matches

**If this fails:** it's a network problem, not a code problem. Likely client isolation on the router. Try a different network (e.g. phone hotspot with Mac joined to it) before continuing.

---

## Stage 1 — Core in Node, on the Mac

Both ends in Node because it's the language you already know and runs natively on the Mac. The logic carries over directly to the real app later.

- [x] Confirm Node is installed: `node -v`
- [x] Create a project folder
- [x] Write `receive.js` (listens on a port, dumps everything to a file):

```js
const net = require('net'), fs = require('fs');
net.createServer(socket => {
  console.log('sender connected');
  socket.pipe(fs.createWriteStream('received.bin'));
  socket.on('end', () => console.log('done'));
}).listen(1234, () => console.log('listening on 1234'));
```

- [ ] Write `send.js` (connects, streams a file, exits):

```js
const net = require('net'), fs = require('fs');
const [,, file, ip] = process.argv;
const socket = net.connect(1234, ip, () => {
  fs.createReadStream(file).pipe(socket);
});
socket.on('close', () => console.log('sent'));
```

- [x] Test Mac → Mac first (two terminals on the same machine, use `127.0.0.1` as the IP) to confirm the scripts work in isolation

`pipe` handles streaming and backpressure for you, so big files won't blow up memory. You get that for free.

---

## Stage 2 — Bring Android in (still no app)

Use Termux as a throwaway scaffold to run the *same* Node scripts on the phone. This proves the feature on real hardware before committing to any UI.

- [x] Install **Termux** on Android (from F-Droid, not the outdated Play Store version)
- [ ] In Termux: `pkg install nodejs`
- [ ] Copy `send.js` and `receive.js` onto the phone (or just retype them — they're tiny)
- [ ] Find the phone's IP: in Termux run `ifconfig` (or check WiFi settings)

---

## Stage 3 — The real test: both directions on real devices

- [ ] **Mac → Android:** run `receive.js` on the phone, `node send.js myfile.pdf <phone-ip>` on the Mac
- [ ] **Android → Mac:** run `receive.js` on the Mac, `node send.js myfile.pdf <mac-ip>` on the phone
- [ ] Verify the received file opens and is intact both ways

**When this works, the MVP is done.** The hard, scary part — "can a custom app move files locally between these two ecosystems" — is now answered: yes.

---

## Deliberately NOT doing yet

Resist adding any of these now. Each one is a separate, later step:

- Filename (hardcoded to `received.bin` for now)
- File size / progress
- Multiple files
- Resume after interruption
- QR pairing
- Encryption
- Choosing save location
- The React Native UI

---

## The one seam to notice (your next step, v0.2)

The crude version has exactly one limitation worth understanding: **the receiver only knows the transfer finished because the socket closed, and it has no idea what the file was called.**

That single gap is where the real protocol grows. v0.2 is just: send a small JSON header line first, then the bytes.

```
{"name":"x.pdf","size":12345}\n
<raw file bytes follow>
```

Everything on your feature wishlist hangs off that header:

- **Progress** = bytes received ÷ `size`
- **Resume** = start reading from byte N
- **Multi-file** = loop, one header + body per file
- **Save location** = you now know the real filename to save as

So the crude version isn't a dead end — it's the trunk everything else grows from.

---

## Suggested order from here

1. Get Stage 0–3 working (this document)
2. Add the JSON header protocol (v0.2) → unlocks filename + size + progress
3. Add resume + multi-file queue
4. *Then* build the React Native app around the working core (QR pairing, UI, save dialog)
5. Last: security (TLS with pinned cert from the QR), reconnect via mDNS
