// Pure helpers and the USB accessory tunnel (driven by a fake phone, no hardware needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clip, createServer, encodeFrame, FRAME, frameReader, parsePaths, tunnel, UI, usbParts } from "./fshare.ts";

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, ""); // eslint-disable-line no-control-regex

test("parsePaths handles quotes, escapes and spaces", () => {
  assert.deepEqual(parsePaths(`'/a b/c.txt'  /d\\ e "/f"`), ["/a b/c.txt", "/d e", "/f"]);
  assert.deepEqual(parsePaths(""), []);
});

test("clip cuts to visible width and keeps color codes", () => {
  const s = "\x1b[1mhello\x1b[22m world";
  assert.equal(plain(clip(s, 5)), "hello");
  assert.equal(clip(s, 50), s);
});

test("status line: waiting, then connected phones", () => {
  const ui = new UI();
  assert.match(plain(ui.status()), /Waiting for a phone/);
  ui.seen("Galaxy S23", true);
  ui.seen("Pixel 8", false);
  assert.match(plain(ui.status()), /Galaxy S23 · USB cable.*Pixel 8 · Wi-Fi/);
});

test("progress line: one line, totals across files", () => {
  const ui = new UI();
  assert.equal(ui.progress(100), null);
  ui.active.add({ name: "a/clip.mp4", dir: "down", done: 50e6, total: 100e6, rate: 10e6, last: 0, cancel: () => {} });
  const one = plain(ui.progress(120)!);
  assert.match(one, /↓ clip\.mp4 .* 50%.*50\.0 MB of 100\.0 MB.*10\.0 MB\/s.*5s left/);
  assert.ok(!one.includes("\n"));
  ui.active.add({ name: "b.bin", dir: "up", done: 0, total: 100e6, rate: 0, last: 0, cancel: () => {} });
  assert.match(plain(ui.progress(120)!), /⇅ 2 files .* 25%/);
});

test("confirm line names the files and who gets them", () => {
  const ui = new UI();
  assert.equal(ui.confirm(), null);
  ui.pending = { label: "trip", count: 12, size: 48e6, commit: () => {} };
  assert.match(plain(ui.confirm()!), /Send trip \(12 files\) · 48\.0 MB to the next phone that connects\?.*y send · n cancel/);
  ui.seen("Galaxy S23", true);
  assert.match(plain(ui.confirm()!), /to Galaxy S23\?/);
});

test("frames round-trip, split across and packed into transfers", () => {
  const got: [number, number, string][] = [];
  const read = frameReader((type, id, data) => got.push([type, id, data.toString()]));
  const all = Buffer.concat([encodeFrame(1, 7), encodeFrame(2, 7, Buffer.from("hello")), encodeFrame(3, 7)]);
  for (let i = 0; i < all.length; i += 4) read(all.subarray(i, i + 4)); // 4-byte dribbles
  assert.deepEqual(got, [
    [1, 7, ""],
    [2, 7, "hello"],
    [3, 7, ""],
  ]);
  assert.throws(() => frameReader(() => {})(encodeFrame(2, 1, Buffer.alloc(FRAME + 1))), /bad frame/);
});

test("usb transfers never end on a whole packet (except full 16 KB reads)", () => {
  assert.deepEqual(
    usbParts(Buffer.alloc(1024), 512).map((b) => b.length),
    [1023, 1],
  );
  assert.deepEqual(
    usbParts(Buffer.alloc(1000), 512).map((b) => b.length),
    [1000],
  );
  assert.deepEqual(
    usbParts(Buffer.alloc(FRAME * 2), 512).map((b) => b.length),
    [FRAME * 2],
  );
});

// A phone in accessory mode, as the `usb` package presents it.
function fakePhone() {
  const toMac: Buffer[] = [];
  const waiting: ((r: object) => void)[] = [];
  const fromMac: Buffer[] = [];
  const ok = (b: Buffer) => ({ status: "ok", data: new DataView(b.buffer, b.byteOffset, b.length) });
  const endpoints = [
    { direction: "in", type: "bulk", endpointNumber: 1, packetSize: 512 },
    { direction: "out", type: "bulk", endpointNumber: 2, packetSize: 512 },
  ];
  return {
    fromMac,
    configuration: { interfaces: [{ interfaceNumber: 0, alternate: { endpoints } }] },
    open: async () => {},
    close: async () => {},
    claimInterface: async () => {},
    selectConfiguration: async () => {},
    transferIn: () => new Promise((res) => (toMac.length ? res(ok(toMac.shift()!)) : waiting.push(res))),
    transferOut: async (_ep: number, b: Buffer) => {
      fromMac.push(Buffer.from(b));
      return { status: "ok" };
    },
    send: (b: Buffer) => (waiting.length ? waiting.shift()!(ok(b)) : toMac.push(b)),
    unplug: () => waiting.splice(0).forEach((w) => w({ status: "stall" })),
  };
}

test("accessory tunnel: the phone reaches this server over the cable", async () => {
  const server = createServer({ token: "tok", outDir: "/tmp", shared: [], name: "Test Mac" }).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const phone = fakePhone();
  const done = tunnel(phone, (server.address() as any).port).catch(() => {});
  try {
    // the app on the phone opens connection 3 and asks for the pairing token
    phone.send(encodeFrame(1, 3));
    phone.send(encodeFrame(2, 3, Buffer.from("GET /pair HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")));

    let reply = "",
      closed = false;
    const read = frameReader((type, id, data) => {
      if (id !== 3) return;
      if (type === 2) reply += data.toString();
      if (type === 3) closed = true;
    });
    for (let seen = 0, t = Date.now(); !closed && Date.now() - t < 3000;) {
      while (seen < phone.fromMac.length) read(phone.fromMac[seen++]);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(closed, "connection closed after the reply");
    assert.match(reply, /^HTTP\/1\.1 200/);
    assert.match(reply, /\r\ntok\r\n/, "loopback through the cable gets the token");
    for (const b of phone.fromMac) assert.ok(b.length % 512 !== 0 || b.length % FRAME === 0, `no stalling transfer (${b.length} bytes)`);
  } finally {
    phone.unplug();
    await done;
    server.close();
  }
});
