import { execFile } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { CONFIG } from "./config.ts";
import { c, type UI } from "./term.ts";

const exec = promisify(execFile);
const APP_ID = "dev.akdevv.fshare";

// ── With USB debugging: adb ──────────────────────────────────────────────────

// adb from PATH, else a private copy, else Google's platform-tools downloaded once
async function findAdb(ui: UI): Promise<string | null> {
  const local = path.join(CONFIG, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  for (const bin of ["adb", local])
    try {
      await exec(bin, ["version"]);
      return bin;
    } catch {}
  const platform = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  if (!platform) return null;
  ui.log(c.dim("  Downloading adb for USB transfers (one time, ~15 MB)…"));
  try {
    const r = await fetch(`https://dl.google.com/android/repository/platform-tools-latest-${platform}.zip`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const zip = path.join(CONFIG, "platform-tools.zip");
    fs.mkdirSync(CONFIG, { recursive: true });
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    await (process.platform === "win32" ? exec("tar", ["-xf", zip, "-C", CONFIG]) : exec("unzip", ["-qo", zip, "-d", CONFIG]));
    fs.rmSync(zip);
    return local;
  } catch (e) {
    ui.log(`  ${c.yellow("!")} ${c.dim(`Couldn't download adb (${(e as Error).message}). USB is off; Wi-Fi still works.`)}`);
    return null;
  }
}

// For every phone adb sees: tunnel the phone's 127.0.0.1:4747 to this server and open the app,
// which probes that port and pairs itself. `ready` gets the serials adb is handling.
export async function watchAdb(port: number, ui: UI, ready: Set<string>) {
  const adb = await findAdb(ui);
  if (!adb) return;
  const handled = new Map<string, string>(); // serial → the state we last acted on
  const tick = async () => {
    let out: string;
    try {
      out = (await exec(adb, ["devices"])).stdout;
    } catch {
      return;
    }
    const now = new Map(
      out
        .split("\n")
        .slice(1)
        .map((l) => l.trim().split(/\s+/))
        .filter((p): p is [string, string] => p.length === 2),
    );
    for (const [id, state] of now) {
      if (handled.get(id) === state) continue;
      if (state === "device") {
        try {
          await exec(adb, ["-s", id, "reverse", "tcp:4747", `tcp:${port}`]);
          exec(adb, ["-s", id, "shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"]).catch(() => {});
        } catch {
          ui.log(`  ${c.red("!")} Couldn't set up the USB tunnel for ${id}`);
        }
      } else if (state === "unauthorized")
        ui.log(`  ${c.yellow("!")} Tap "Allow" on the phone ${c.dim('(tick "Always allow from this computer")')}`);
      handled.set(id, state);
    }
    for (const id of handled.keys()) if (!now.has(id)) handled.delete(id);
    ready.clear();
    for (const [id, state] of now) if (state === "device") ready.add(id);
  };
  tick();
  setInterval(tick, 2000).unref();
}

// ── Without USB debugging: Android Open Accessory ────────────────────────────
// As the USB host, this computer asks the phone to switch into "accessory" mode (the protocol
// Android Auto uses); Android then offers to open fshare and hands it a raw bulk pipe. The app
// multiplexes its HTTP connections over that pipe in frames, [type:1][conn:4][len:4][payload],
// and each one is connected to the local server. The phone side is UsbTunnel.kt.

const AOA = { vendor: 0x18d1, products: [0x2d00, 0x2d01] };
export const FRAME = 16384;
const HEADER = 9;
const OPEN = 1,
  DATA = 2,
  CLOSE = 3;
// interface classes that are never a phone: audio, HID, mass storage, hub, video, wireless
const NOT_PHONE = new Set([0x01, 0x03, 0x08, 0x09, 0x0e, 0xe0]);
const APPLE = 0x05ac;
const vendorRequest = (request: number, index = 0) => ({
  requestType: "vendor" as const,
  recipient: "device" as const,
  request,
  value: 0,
  index,
});

export async function watchAccessory(port: number, adbReady: Set<string>) {
  let usb: any;
  try {
    ({ usb } = await import("usb"));
  } catch {
    return; // no prebuilt binary for this platform: adb only
  }
  const firstSeen = new Map<string, number>();
  const busy = new Set<string>(); // tunnelling to it, or already tried this plug-in
  const tick = async () => {
    let devices: any[];
    try {
      devices = await usb.getDevices();
    } catch {
      return;
    }
    const here = new Set(devices.map((d) => `${d.bus}:${d.address}`));
    for (const k of firstSeen.keys())
      if (!here.has(k)) {
        firstSeen.delete(k);
        busy.delete(k);
      }
    for (const d of devices) {
      const key = `${d.bus}:${d.address}`;
      if (busy.has(key)) continue;
      if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
      if (d.vendorId === AOA.vendor && AOA.products.includes(d.productId)) {
        busy.add(key);
        tunnel(d, port)
          .catch(() => {})
          .finally(() => busy.delete(key));
        continue;
      }
      if (Date.now() - firstSeen.get(key)! < 3000) continue; // give adb a moment: phones with USB debugging keep using it
      busy.add(key);
      if (d.vendorId === APPLE || d.deviceClass === 0x09 || adbReady.has(d.serialNumber ?? "")) continue;
      if (d.configuration?.interfaces.some((i: any) => NOT_PHONE.has(i.alternate.interfaceClass))) continue;
      switchToAccessory(d).catch(() => setTimeout(() => busy.delete(key), 5000)); // still settling, say: try again
    }
  };
  tick();
  setInterval(tick, 1500).unref();
}

export async function switchToAccessory(d: any) {
  await d.open();
  try {
    const r = await d.controlTransferIn(vendorRequest(51), 2); // the AOA version; anything not Android fails here
    if (r.status !== "ok" || !r.data || r.data.getUint16(0, true) < 1) return;
    const ids = ["akdevv", "fshare", "fshare phone link", "1", "https://github.com/akdevv", "fshare"];
    for (const [i, s] of ids.entries()) await d.controlTransferOut(vendorRequest(52, i), new TextEncoder().encode(s + "\0"));
    // node-usb needs a buffer even when there's no data: without one it throws and the phone never switches
    await d.controlTransferOut(vendorRequest(53), new Uint8Array(0));
  } finally {
    await d.close().catch(() => {});
  }
}

export function encodeFrame(type: number, id: number, data?: Buffer): Buffer {
  const b = Buffer.allocUnsafe(HEADER + (data?.length ?? 0));
  b.writeUInt8(type, 0);
  b.writeInt32BE(id, 1);
  b.writeInt32BE(data?.length ?? 0, 5);
  data?.copy(b, HEADER);
  return b;
}

// A frame can be split across USB transfers, or share one with others.
export function frameReader(onFrame: (type: number, id: number, data: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER) {
      const len = pending.readInt32BE(5);
      if (len < 0 || len > FRAME) throw new Error("bad frame");
      if (pending.length < HEADER + len) break;
      onFrame(pending[0], pending.readInt32BE(1), Buffer.from(pending.subarray(HEADER, HEADER + len)));
      pending = pending.subarray(HEADER + len);
    }
  };
}

// The phone reads 16 KB at a time and only returns early on a short packet, so a transfer that's
// a whole number of packets (but not of 16 KB) would leave it waiting: its last byte goes separately.
export function usbParts(buf: Buffer, packetSize: number): Buffer[] {
  const n = buf.length;
  return n % packetSize === 0 && n % FRAME !== 0 ? [buf.subarray(0, n - 1), buf.subarray(n - 1)] : [buf];
}

const BATCH = 1 << 18;
const RESUME_BELOW = 1 << 20;
const PAUSE_ABOVE = 4 << 20;
// node-usb has no "wait forever" (a timeout of 0 cancels at once), so a read waits IDLE ms and, if
// the phone said nothing, fails as "Cancelled": that's just quiet, so read again. Failing much
// faster than that, over and over, means the phone is gone.
const IDLE = 10_000;
const READS = 4;

export async function tunnel(d: any, port: number) {
  await d.open();
  if (!d.configuration) await d.selectConfiguration(1);
  const iface = d.configuration.interfaces[0];
  await d.claimInterface(iface.interfaceNumber);
  const endpoints = iface.alternate.endpoints;
  const inEp = endpoints.find((e: any) => e.direction === "in" && e.type === "bulk");
  const outEp = endpoints.find((e: any) => e.direction === "out" && e.type === "bulk");
  const conns = new Map<number, net.Socket>();
  let alive = true;

  // writes: frames are batched into big transfers, and sockets pause while the cable is behind
  const queue: Buffer[] = [];
  const paused = new Set<net.Socket>();
  let queued = 0,
    sending = false;
  const flush = async () => {
    sending = true;
    try {
      while (queue.length && alive) {
        const batch: Buffer[] = [];
        let n = 0;
        while (queue.length && n + queue[0].length <= BATCH) {
          const b = queue.shift()!;
          batch.push(b);
          n += b.length;
        }
        queued -= n;
        for (const p of usbParts(Buffer.concat(batch, n), outEp.packetSize)) await d.transferOut(outEp.endpointNumber, p, 10_000);
        if (queued < RESUME_BELOW) {
          for (const s of paused) s.resume();
          paused.clear();
        }
      }
    } catch {
      stop();
    }
    sending = false;
  };
  const frame = (type: number, id: number, data?: Buffer) => {
    if (!alive) return;
    const b = encodeFrame(type, id, data);
    queue.push(b);
    queued += b.length;
    if (!sending) flush();
  };
  const stop = () => {
    if (!alive) return;
    alive = false;
    for (const s of conns.values()) s.destroy();
    conns.clear();
  };

  const connect = (id: number) => {
    const s = net.connect(port, "127.0.0.1");
    s.setNoDelay(true);
    conns.set(id, s);
    s.on("data", (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += FRAME - HEADER) frame(DATA, id, chunk.subarray(i, i + FRAME - HEADER));
      if (queued > PAUSE_ABOVE) {
        s.pause();
        paused.add(s);
      }
    });
    const end = () => {
      if (conns.delete(id)) frame(CLOSE, id);
    };
    s.on("close", end);
    s.on("error", end);
  };

  const onData = frameReader((type, id, data) => {
    if (type === OPEN) connect(id);
    else if (type === DATA) conns.get(id)?.write(data);
    else if (type === CLOSE) {
      conns.get(id)?.destroy();
      conns.delete(id);
    }
  });

  // reads: a few queued at once keep the pipe full. Each gets a handler right away: when the link
  // drops they all fail, and an unhandled one would crash the process.
  const read = () => {
    const p = d.transferIn(inEp.endpointNumber, FRAME, IDLE);
    p.catch(() => {});
    return { p, at: Date.now() };
  };
  const reads = Array.from({ length: READS }, read);
  let quickFails = 0;
  try {
    while (alive) {
      const { p, at } = reads.shift()!;
      let r: any;
      try {
        r = await p;
      } catch (e) {
        if (!/cancel/i.test((e as Error)?.message ?? "")) throw e;
        quickFails = Date.now() - at < IDLE / 2 ? quickFails + 1 : 0;
        if (quickFails > 8) throw e;
        reads.push(read());
        continue;
      }
      quickFails = 0;
      if (r.status !== "ok") throw new Error(r.status); // before queueing another read, which would hold up the close
      reads.push(read());
      if (r.data?.byteLength) onData(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength));
    }
  } finally {
    stop();
    // the device can't close with a read still out, but never wait forever: the watcher would think
    // this tunnel still runs and never start the next one
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await Promise.race([Promise.allSettled(reads.map((x) => x.p)), wait(IDLE + 2000)]);
    await Promise.race([d.close().catch(() => {}), wait(2000)]);
  }
}
