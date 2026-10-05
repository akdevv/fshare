#!/usr/bin/env node
// fshare — LAN file transfer. Laptop runs this HTTP server; phone app talks to it.
//   GET  /list?t=TOKEN          -> [{ id, path, size }]  files the laptop is sharing
//   GET  /file/:id?t=TOKEN      -> raw file bytes
//   PUT  /upload?t=TOKEN&name=  -> raw body saved to OUT_DIR/name
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { styleText } from "node:util";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import qrcode from "qrcode-terminal";

const CHUNK = 1 << 20; // 1 MB stream buffers: fewer syscalls, higher throughput
const PART = ".fshare-part"; // in-progress uploads; renamed on success, deleted on cancel
// Resumable uploads (phone sends ?id=): parts live here, not in Downloads, until complete.
export const PARTS = path.join(os.tmpdir(), "fshare-parts");
export const KEEP_MS = 5 * 60_000; // a stopped upload waits this long for the phone to resume it

// Drop parts nobody resumed in time. `busy`: parts being written right now.
export function sweepParts(dir: string, busy: Set<string>, keep = KEEP_MS, now = Date.now()) {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // no parts yet
  }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (!busy.has(f) && now - fs.statSync(f).mtimeMs > keep) fs.rmSync(f, { force: true });
    } catch {}
  }
}
const VERSION = "2";
const PKG_VERSION = (() => {
  for (const p of ["./package.json", "../package.json"])
    try {
      return JSON.parse(fs.readFileSync(new URL(p, import.meta.url), "utf8")).version;
    } catch {}
  return "?";
})(); // the app shows a "restart fshare" hint when a laptop runs an older build

// `delivered`: phones (by app id) that already downloaded it, so each phone gets each file once
export type Shared = { id: number; path: string; size: number; abs: string; delivered?: Set<string> };

// Split a line of drag-and-dropped paths. Handles 'quotes', "quotes" and back\ slash escapes.
export function parsePaths(line: string): string[] {
  const out: string[] = [];
  let cur = "",
    quote = "",
    any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = "";
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      any = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (c === " " || c === "\t") {
      if (any || cur) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += c;
      any = true;
    }
  }
  if (any || cur) out.push(cur);
  return out;
}

// Expand files/folders into a flat list. Folder contents keep "folder/sub/file" paths.
export function expand(p: string): { rel: string; abs: string; size: number }[] {
  const abs = path.resolve(p.replace(/^~(?=$|\/)/, os.homedir()));
  const st = fs.statSync(abs);
  if (st.isFile()) return [{ rel: path.basename(abs), abs, size: st.size }];
  const base = path.dirname(abs);
  return fs
    .readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith("."))
    .map((d) => {
      const f = path.join(d.parentPath, d.name);
      return { rel: path.relative(base, f).split(path.sep).join("/"), abs: f, size: fs.statSync(f).size };
    });
}

// Resolve an uploaded name inside outDir. Rejects traversal; never overwrites (adds " (1)").
// `taken` holds names reserved by uploads still in flight.
export function safeDest(outDir: string, name: string, taken = new Set<string>()): string | null {
  const root = path.resolve(outDir);
  const dest = path.resolve(root, name.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!dest.startsWith(root + path.sep)) return null;
  const { dir, name: stem, ext } = path.parse(dest);
  let p = dest;
  for (let i = 1; fs.existsSync(p) || taken.has(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}

// ── terminal UI ────────────────────────────────────────────────────────────
// History (finished files, notices) scrolls up; below it sits a live area redrawn in place:
//   ● Galaxy S23 · USB cable                     <- who is connected
//   ↓ clip.mp4  ━━━━━━━━━━━──────  62%  1.2 GB of 2.0 GB  34.1 MB/s  25s left
//   › drop files here + Enter   q Wi-Fi QR · x cancel · ctrl+c quit
const c = {
  dim: (s: string) => styleText("dim", s),
  bold: (s: string) => styleText("bold", s),
  green: (s: string) => styleText("green", s),
  red: (s: string) => styleText("red", s),
  cyan: (s: string) => styleText("cyan", s),
  yellow: (s: string) => styleText("yellow", s),
  magenta: (s: string) => styleText("magenta", s),
  lime: (s: string) => styleText(["bold", "greenBright"], s),
};
const mbs = (b: number) => `${(b / 1e6).toFixed(1)} MB/s`;
const fmt = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);
const left = (s: number) =>
  !isFinite(s) || s <= 0
    ? ""
    : s < 60
      ? `${Math.ceil(s)}s left`
      : s < 3600
        ? `${Math.ceil(s / 60)} min left`
        : `${(s / 3600).toFixed(1)} h left`;
const bar = (f: number, n: number) => {
  const k = Math.round(Math.max(0, Math.min(1, f)) * n);
  return c.lime("━".repeat(k)) + c.dim("─".repeat(n - k));
};
const home = (p: string) => p.replace(os.homedir(), "~");
const shorten = (s: string, n: number) =>
  s.length > n ? s.slice(0, Math.ceil(n / 2) - 1) + "…" + s.slice(s.length - Math.floor(n / 2)) : s;

// Cut a styled string to n visible columns, so a live line never wraps (a wrapped line
// would break the in-place redraw and leave copies of the progress line behind).
export function clip(s: string, n: number): string {
  let out = "",
    vis = 0;
  for (let i = 0; i < s.length; i++) {
    // eslint-disable-next-line no-control-regex -- matching terminal color codes is the point
    const esc = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
    if (esc) {
      out += esc[0];
      i += esc[0].length - 1;
      continue;
    }
    if (vis >= n) return out + "\x1b[0m";
    out += s[i];
    vis++;
  }
  return out;
}

type Active = { name: string; dir: "up" | "down"; done: number; total: number; rate: number; last: number; cancel: () => void };
type Client = { name: string; usb: boolean; seen: number };

// Files dropped into the terminal wait here until you confirm sending them.
export type Pending = { label: string; count: number; size: number; commit: () => void };

export class UI {
  pending: Pending | null = null;
  active = new Set<Active>();
  clients = new Map<string, Client>(); // phones polling us, by name + link
  input = "";
  private drawn = 0; // lines of the live area currently on screen
  private tty = !!process.stdout.isTTY;

  private clear() {
    if (!this.drawn) return;
    process.stdout.write(`\r${this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : ""}\x1b[J`);
    this.drawn = 0;
  }
  log(msg: string) {
    this.clear();
    console.log(msg);
    this.draw();
  }

  seen(name: string, usb: boolean) {
    const key = `${name}|${usb}`;
    const known = this.clients.has(key);
    this.clients.set(key, { name, usb, seen: Date.now() });
    if (!known) this.redraw();
  }

  tick(dt: number) {
    for (const a of this.active) {
      a.rate = a.rate * 0.5 + ((a.done - a.last) / dt) * 0.5;
      a.last = a.done;
    }
    for (const [k, p] of this.clients) if (Date.now() - p.seen > 5000) this.clients.delete(k);
    this.redraw();
  }
  redraw() {
    this.clear();
    this.draw();
  }

  status(): string {
    if (!this.clients.size) return `  ${c.yellow("○")} ${c.dim("Waiting for a phone · plug it in, or press q to connect over Wi-Fi")}`;
    return (
      "  " +
      [...this.clients.values()].map((p) => `${c.green("●")} ${c.bold(p.name)} ${c.dim(`· ${p.usb ? "USB cable" : "Wi-Fi"}`)}`).join("   ")
    );
  }

  progress(width: number): string | null {
    const all = [...this.active];
    if (!all.length) return null;
    const total = all.reduce((s, a) => s + a.total, 0),
      done = all.reduce((s, a) => s + a.done, 0),
      rate = all.reduce((s, a) => s + a.rate, 0);
    const dirs = new Set(all.map((a) => a.dir));
    const arrow = dirs.size > 1 ? c.cyan("⇅") : dirs.has("down") ? c.magenta("↓") : c.green("↑");
    const label = all.length === 1 ? path.basename(all[0].name) : `${all.length} files`;
    const f = total ? done / total : 0;
    const tail = `  ${String(Math.floor(f * 100)).padStart(3)}%  ${c.dim(`${fmt(done)} of ${fmt(total)}`)}  ${c.bold(mbs(rate))}  ${c.dim(left((total - done) / rate))}`;
    const room = Math.max(10, width - 2 - 2 - 2 - 64); // what's left for the name next to a 20-wide bar
    return `  ${arrow} ${shorten(label, Math.min(32, room))}  ${bar(f, 20)}${tail}`;
  }

  confirm(): string | null {
    const p = this.pending;
    if (!p) return null;
    const names = [...new Set([...this.clients.values()].map((x) => x.name))];
    const to = names.length ? names.join(" and ") : "the next phone that connects";
    const what = p.count === 1 ? p.label : `${p.label}${p.count > 1 ? ` (${p.count} files)` : ""}`;
    return `  ${c.yellow("?")} Send ${c.bold(what)} ${c.dim(`· ${fmt(p.size)}`)} to ${c.bold(to)}?   ${c.lime("y")} ${c.dim("send ·")} ${c.bold("n")} ${c.dim("cancel")}`;
  }

  done = false; // quitting: leave the live area off the screen
  private draw() {
    if (!this.tty || this.done) return;
    const w = process.stdout.columns || 100;
    const prompt =
      this.confirm() ??
      (this.input
        ? `  ${c.cyan("›")} ${this.input.length > w - 6 ? "…" + this.input.slice(-(w - 7)) : this.input}`
        : `  ${c.cyan("›")} ${c.dim("drop files here + Enter")}   ${c.dim("q")} ${c.dim("Wi-Fi QR ·")} ${c.dim("x")} ${c.dim("cancel ·")} ${c.dim("ctrl+c")} ${c.dim("quit")}`);
    const lines = ["", this.status(), this.progress(w), prompt].filter((l): l is string => l !== null).map((l) => clip(l, w - 1));
    process.stdout.write(lines.join("\n"));
    if (!this.input && !this.pending) process.stdout.write(`\r\x1b[4C`); // park the cursor right after "›"
    this.drawn = lines.length;
  }
}

// "Ashish's MacBook Air" on macOS; hostname elsewhere. Shown in the phone app.
export function computerName(): string {
  if (process.platform === "darwin")
    try {
      return execFileSync("scutil", ["--get", "ComputerName"]).toString().trim();
    } catch {}
  return os.hostname().replace(/\.local$/, "");
}

export function createServer(opts: { token: string; outDir: string; shared: Shared[]; ui?: UI; name?: string; partsDir?: string }) {
  const { token, outDir, shared } = opts;
  const partsDir = opts.partsDir ?? PARTS;
  const partOf = (id: string) => path.join(partsDir, id.replace(/[^\w-]/g, "").slice(0, 80) || "x");
  const sizeOf = (f: string) => {
    try {
      return fs.statSync(f).size;
    } catch {
      return 0;
    }
  };
  const name = encodeURIComponent(opts.name ?? computerName());
  const ui = opts.ui ?? new UI();
  const taken = new Set<string>();
  const writing = new Set<string>(); // parts mid-upload, never swept

  const track = (stream: NodeJS.ReadableStream, name: string, total: number, dir: Active["dir"], cancel: () => void, start = 0) => {
    const a: Active = { name, dir, done: start, total, rate: 0, last: start, cancel };
    ui.active.add(a);
    stream.on("data", (b: Buffer) => {
      a.done += b.length;
    });
    return () => ui.active.delete(a);
  };
  const took = (t0: number, size: number) => c.dim(`${fmt(size)} · ${mbs(size / ((Date.now() - t0) / 1000 || 1))}`);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    // USB pairing: only loopback can reach this, i.e. the phone through the adb cable tunnel
    // (or a process on this laptop). Wi-Fi clients must have scanned the QR instead.
    if (url.pathname === "/pair") {
      const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
      if (local) res.writeHead(200).end(token);
      else res.writeHead(403).end();
      return;
    }
    if (url.searchParams.get("t") !== token) {
      res.writeHead(403).end("bad token");
      return;
    }

    const phone = url.searchParams.get("c"); // the app's id, to hand each phone each file once
    if (req.method === "GET" && url.pathname === "/list") {
      const addr = req.socket.remoteAddress?.replace("::ffff:", "") ?? "";
      const client = req.headers["x-fshare-client"];
      ui.seen(typeof client === "string" ? decodeURIComponent(client) : "Phone", addr === "127.0.0.1" || addr === "::1");
      res
        .writeHead(200, {
          "content-type": "application/json",
          "x-fshare-name": name,
          "x-fshare-version": VERSION,
          "x-fshare-kind": "laptop",
        })
        .end(JSON.stringify(shared.filter((s) => !(phone && s.delivered?.has(phone))).map(({ id, path, size }) => ({ id, path, size }))));
      return;
    }

    const m = url.pathname.match(/^\/file\/(\d+)$/);
    if (req.method === "DELETE" && m) {
      // removed from the list on the phone; the file itself stays put
      const i = shared.findIndex((s) => s.id === Number(m[1]));
      if (i >= 0) {
        ui.log(`  ${c.dim("−")} ${c.dim(`Unshared  ${shared[i].path}`)}`);
        shared.splice(i, 1);
      }
      res.writeHead(200).end("ok");
      return;
    }
    if (req.method === "GET" && m) {
      const f = shared.find((s) => s.id === Number(m[1]));
      if (!f) {
        res.writeHead(404).end();
        return;
      }
      // "Range: bytes=N-" lets a paused download on the phone continue from where it stopped.
      // iOS only produces resume data when the file has an ETag/Last-Modified, and resumes with
      // If-Range: if the file changed since, send it whole.
      const st = fs.statSync(f.abs);
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`,
        modified = st.mtime.toUTCString();
      const ifRange = req.headers["if-range"];
      const fresh = !ifRange || ifRange === etag || ifRange === modified;
      const from = fresh ? Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0) : 0;
      if (from >= f.size && from > 0) {
        res.writeHead(416, { "content-range": `bytes */${f.size}` }).end();
        return;
      }
      res.writeHead(from ? 206 : 200, {
        "content-type": "application/octet-stream",
        "content-length": f.size - from,
        "accept-ranges": "bytes",
        etag,
        "last-modified": modified,
        ...(from && { "content-range": `bytes ${from}-${f.size - 1}/${f.size}` }),
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(f.path))}`,
      });
      const src = fs.createReadStream(f.abs, { highWaterMark: CHUNK, start: from });
      const untrack = track(src, f.path, f.size, "down", () => res.destroy(), from);
      const t0 = Date.now();
      try {
        await pipeline(src, res);
        untrack();
        if (phone) (f.delivered ??= new Set()).add(phone);
        ui.log(`  ${c.green("✓")} Sent      ${f.path}  ${took(t0, f.size)}`);
      } catch {
        untrack();
        ui.log(`  ${c.yellow("‖")} Stopped   ${f.path}  ${c.dim("paused or cancelled on the phone")}`);
      }
      return;
    }

    const id = url.pathname === "/upload" ? url.searchParams.get("id") : null;
    if (id && req.method === "GET") {
      // how much of a paused upload already arrived
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ received: sizeOf(partOf(id)) }));
      return;
    }
    if (id && req.method === "DELETE") {
      // cancelled on the phone
      fs.rmSync(partOf(id), { force: true });
      res.writeHead(200).end("ok");
      return;
    }
    if (id && req.method === "PUT") {
      const name = url.searchParams.get("name") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const size = Number(url.searchParams.get("size") ?? 0);
      const part = partOf(id);
      if (!name || !safeDest(outDir, name)) {
        res.writeHead(400).end("bad name");
        return;
      }
      if (offset > sizeOf(part)) {
        res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ received: sizeOf(part) }));
        return;
      }
      fs.mkdirSync(partsDir, { recursive: true });
      writing.add(part);
      if (offset) fs.truncateSync(part, offset);
      else fs.rmSync(part, { force: true });
      let cancelled = false;
      const untrack = track(
        req,
        name,
        size,
        "up",
        () => {
          cancelled = true;
          req.destroy();
        },
        offset,
      );
      const t0 = Date.now();
      try {
        await pipeline(req, fs.createWriteStream(part, { flags: "a", highWaterMark: CHUNK }));
        if (sizeOf(part) !== size) throw new Error("incomplete");
        const dest = safeDest(outDir, name, taken)!;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        try {
          fs.renameSync(part, dest);
        } catch {
          fs.copyFileSync(part, dest);
          fs.rmSync(part);
        } // tmp may be another volume
        res.writeHead(200).end("ok");
        untrack();
        ui.log(`  ${c.green("✓")} Received  ${home(dest)}  ${took(t0, size - offset)}`);
      } catch {
        untrack();
        if (cancelled) {
          fs.rmSync(part, { force: true });
          ui.log(`  ${c.red("✗")} Cancelled ${name}`);
        } else ui.log(`  ${c.yellow("‖")} Paused    ${name}  ${c.dim(`${fmt(sizeOf(part))} of ${fmt(size)} kept for 5 min`)}`);
      } finally {
        writing.delete(part);
      }
      return;
    }

    if (req.method === "PUT" && url.pathname === "/upload") {
      const name = url.searchParams.get("name") ?? "";
      const dest = name && safeDest(outDir, name, taken);
      if (!dest) {
        res.writeHead(400).end("bad name");
        return;
      }
      taken.add(dest);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const total = Number(req.headers["content-length"] ?? 0);
      const untrack = track(req, name, total, "up", () => req.destroy());
      const t0 = Date.now();
      try {
        await pipeline(req, fs.createWriteStream(dest + PART, { highWaterMark: CHUNK }));
        fs.renameSync(dest + PART, dest);
        res.writeHead(200).end("ok");
        untrack();
        ui.log(`  ${c.green("✓")} Received  ${home(dest)}  ${took(t0, total)}`);
      } catch {
        fs.rmSync(dest + PART, { force: true }); // cancelled: don't leave half-written files around
        untrack();
        ui.log(`  ${c.red("✗")} Cancelled ${name}  ${c.dim("partial file deleted")}`);
      }
      taken.delete(dest);
      return;
    }

    res.writeHead(404).end();
  });
  const sweep = setInterval(() => sweepParts(partsDir, writing), 60_000).unref();
  server.on("close", () => clearInterval(sweep));
  return server;
}

function lanIp(): string {
  const all = Object.entries(os.networkInterfaces())
    .flatMap(([n, addrs]) => (addrs ?? []).map((a) => ({ n, ...a })))
    .filter((a) => a.family === "IPv4" && !a.internal);
  // prefer wifi/ethernet over VPN/docker bridges
  return (all.find((a) => /^(en|wl|eth)/.test(a.n)) ?? all[0])?.address ?? "127.0.0.1";
}

// Pairing token persists across runs, so a phone that scanned once can reconnect (e.g. over USB) without scanning.
function pairToken(reset: boolean): string {
  const f = path.join(os.homedir(), ".config", "fshare", "token");
  if (!reset)
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch {}
  const t = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, t, { mode: 0o600 });
  return t;
}

const exec = promisify(execFile);
const APP_ID = "dev.akdevv.fshare";

// Use adb from PATH, else a private copy; download Google's platform-tools once if neither exists.
async function findAdb(ui: UI): Promise<string | null> {
  const dir = path.join(os.homedir(), ".config", "fshare");
  const local = path.join(dir, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
  for (const bin of ["adb", local])
    try {
      await exec(bin, ["version"]);
      return bin;
    } catch {}
  const plat = { darwin: "darwin", linux: "linux", win32: "windows" }[process.platform as string];
  if (!plat) return null;
  ui.log(c.dim("  Downloading adb for USB transfers (one time, ~15 MB)…"));
  try {
    const r = await fetch(`https://dl.google.com/android/repository/platform-tools-latest-${plat}.zip`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const zip = path.join(dir, "platform-tools.zip");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(zip, Buffer.from(await r.arrayBuffer()));
    await (process.platform === "win32" ? exec("tar", ["-xf", zip, "-C", dir]) : exec("unzip", ["-qo", zip, "-d", dir]));
    fs.rmSync(zip);
    return local;
  } catch (e: any) {
    ui.log(`  ${c.yellow("!")} ${c.dim(`Couldn't download adb (${e.message}). USB is off; Wi-Fi still works.`)}`);
    return null;
  }
}

// Plug-and-play USB: for every Android phone adb sees, tunnel phone's 127.0.0.1:4747 to this server
// and open the app. The app probes 127.0.0.1:4747 and pairs itself, so no QR is needed over USB.
// ponytail: polls `adb devices` every 2s; `adb track-devices` if that ever matters.
async function watchUsb(port: number, ui: UI, ready: Set<string>) {
  const adb = await findAdb(ui);
  if (!adb) return;
  const seen = new Map<string, string>(); // serial -> state we last acted on
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
        .filter((p) => p.length === 2) as [string, string][],
    );
    for (const [id, state] of now) {
      if (seen.get(id) === state) continue;
      if (state === "device") {
        try {
          await exec(adb, ["-s", id, "reverse", "tcp:4747", `tcp:${port}`]);
          // open the installed app (no-op if only Expo Go is used)
          exec(adb, ["-s", id, "shell", "monkey", "-p", APP_ID, "-c", "android.intent.category.LAUNCHER", "1"]).catch(() => {});
        } catch {
          ui.log(`  ${c.red("!")} Couldn't set up the USB tunnel for ${id}`);
        }
      } else if (state === "unauthorized")
        ui.log(`  ${c.yellow("!")} Tap "Allow" on the phone ${c.dim('(tick "Always allow from this computer")')}`);
      seen.set(id, state);
    }
    for (const id of seen.keys()) if (!now.has(id)) seen.delete(id); // the status line shows the phone dropping off
    ready.clear();
    for (const [id, state] of now) if (state === "device") ready.add(id);
  };
  tick();
  setInterval(tick, 2000).unref();
}

// ── USB without USB debugging ─────────────────────────────────────────────
// adb needs USB debugging. Without it we use Android Open Accessory (AOA), the protocol cars use
// for Android Auto: this computer, as the USB host, asks the phone to switch into "accessory"
// mode; Android then offers to open fshare and gives it a raw bulk pipe. The app multiplexes its
// HTTP connections over that pipe in 9-byte frames, [type:1][conn:4][len:4][payload], and we
// connect each one to our own server. The phone side lives in mobile/modules/fshare-peer (UsbTunnel.kt).
const AOA = { vid: 0x18d1, pids: [0x2d00, 0x2d01] };
export const FRAME = 16384,
  HEADER = 9,
  OPEN = 1,
  DATA = 2,
  CLOSE = 3;
// interface classes that are never a phone: audio, HID, mass storage, hub, video, wireless
const NOT_PHONE = new Set([0x01, 0x03, 0x08, 0x09, 0x0e, 0xe0]);
const vendor = (request: number, index = 0) => ({ requestType: "vendor" as const, recipient: "device" as const, request, value: 0, index });

async function watchAccessory(port: number, adbReady: Set<string>) {
  let usb: any;
  try {
    ({ usb } = await import("usb"));
  } catch {
    return;
  } // no prebuilt binary for this platform: adb only
  const first = new Map<string, number>(); // device -> when we first saw it
  const busy = new Set<string>(); // devices we're tunnelling to, or already tried
  const tick = async () => {
    let devices: any[];
    try {
      devices = await usb.getDevices();
    } catch {
      return;
    }
    const here = new Set(devices.map((d) => `${d.bus}:${d.address}`));
    for (const k of [...first.keys()])
      if (!here.has(k)) {
        first.delete(k);
        busy.delete(k);
      }
    for (const d of devices) {
      const key = `${d.bus}:${d.address}`;
      if (busy.has(key)) continue;
      if (!first.has(key)) first.set(key, Date.now());
      if (d.vendorId === AOA.vid && AOA.pids.includes(d.productId)) {
        busy.add(key);
        tunnel(d, port)
          .catch(() => {})
          .finally(() => busy.delete(key));
        continue;
      }
      // give adb a few seconds first; phones with USB debugging keep using it
      if (Date.now() - first.get(key)! < 3000) continue;
      busy.add(key); // one attempt per plug-in
      if (d.vendorId === 0x05ac || d.deviceClass === 0x09 || adbReady.has(d.serialNumber ?? "")) continue;
      if (d.configuration?.interfaces.some((i: any) => NOT_PHONE.has(i.alternate.interfaceClass))) continue;
      switchToAccessory(d).catch(() => setTimeout(() => busy.delete(key), 5000)); // e.g. still settling: try again
    }
  };
  tick();
  setInterval(tick, 1500).unref();
}

export async function switchToAccessory(d: any) {
  await d.open();
  try {
    const r = await d.controlTransferIn(vendor(51), 2); // AOA protocol version; non-Android devices fail here
    if (r.status !== "ok" || !r.data || r.data.getUint16(0, true) < 1) return;
    const ids = ["akdevv", "fshare", "fshare phone link", "1", "https://github.com/akdevv", "fshare"];
    for (const [i, s] of ids.entries()) await d.controlTransferOut(vendor(52, i), new TextEncoder().encode(s + "\0"));
    // the phone reconnects as an accessory. node-usb needs a (here empty) buffer even with no data:
    // without one it throws and the phone never switches
    await d.controlTransferOut(vendor(53), new Uint8Array(0));
  } finally {
    await d.close().catch(() => {});
  }
}

// [type:1][conn:4][len:4][payload]
export function encodeFrame(type: number, id: number, data?: Buffer): Buffer {
  const b = Buffer.allocUnsafe(HEADER + (data?.length ?? 0));
  b.writeUInt8(type, 0);
  b.writeInt32BE(id, 1);
  b.writeInt32BE(data?.length ?? 0, 5);
  data?.copy(b, HEADER);
  return b;
}

// Reassembles frames from USB transfers; a frame can be split across transfers or share one.
export function frameReader(onFrame: (type: number, id: number, data: Buffer) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= HEADER) {
      const len = pending.readInt32BE(5);
      if (len < 0 || len > FRAME) throw new Error("bad frame");
      if (pending.length < HEADER + len) break;
      const type = pending[0],
        id = pending.readInt32BE(1),
        data = Buffer.from(pending.subarray(HEADER, HEADER + len));
      pending = pending.subarray(HEADER + len);
      onFrame(type, id, data);
    }
  };
}

// The phone reads 16 KB at a time and only returns early on a short packet, so a transfer that's
// a whole number of packets (but not of 16 KB) would leave it waiting: send its last byte separately.
export function usbParts(buf: Buffer, packetSize: number): Buffer[] {
  const n = buf.length;
  return n % packetSize === 0 && n % FRAME !== 0 ? [buf.subarray(0, n - 1), buf.subarray(n - 1)] : [buf];
}

export async function tunnel(d: any, port: number) {
  await d.open();
  if (!d.configuration) await d.selectConfiguration(1);
  const iface = d.configuration.interfaces[0];
  await d.claimInterface(iface.interfaceNumber);
  const eps = iface.alternate.endpoints;
  const inEp = eps.find((e: any) => e.direction === "in" && e.type === "bulk");
  const outEp = eps.find((e: any) => e.direction === "out" && e.type === "bulk");
  const conns = new Map<number, net.Socket>();
  let alive = true;

  // cable writes: frames are batched into big transfers (see usbParts for the packet rule)
  const queue: Buffer[] = [];
  let queued = 0,
    sending = false;
  const paused = new Set<net.Socket>();
  const send = async () => {
    sending = true;
    try {
      while (queue.length && alive) {
        const batch: Buffer[] = [];
        let n = 0;
        while (queue.length && n + queue[0].length <= 1 << 18) {
          const b = queue.shift()!;
          batch.push(b);
          n += b.length;
        }
        queued -= n;
        const buf = Buffer.concat(batch, n);
        for (const p of usbParts(buf, outEp.packetSize)) await d.transferOut(outEp.endpointNumber, p, 10_000);
        if (queued < 1 << 20)
          for (const s of paused) {
            s.resume();
            paused.delete(s);
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
    if (!sending) send();
  };
  const stop = () => {
    if (!alive) return;
    alive = false; // the read loop notices, waits for its reads to end, then closes the device
    for (const s of conns.values()) s.destroy();
    conns.clear();
  };

  const open = (id: number) => {
    const s = net.connect(port, "127.0.0.1");
    s.setNoDelay(true);
    conns.set(id, s);
    s.on("data", (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i += FRAME - HEADER) frame(DATA, id, chunk.subarray(i, i + FRAME - HEADER));
      if (queued > 4 << 20) {
        s.pause();
        paused.add(s);
      } // the cable is behind; stop reading this socket
    });
    const end = () => {
      if (conns.delete(id)) frame(CLOSE, id);
    };
    s.on("close", end);
    s.on("error", end);
  };

  // cable reads: a few transfers queued at once keeps the pipe full; frames can span transfers
  const onData = frameReader((type, id, data) => {
    if (type === OPEN) open(id);
    else if (type === DATA) conns.get(id)?.write(data);
    else if (type === CLOSE) {
      const s = conns.get(id);
      conns.delete(id);
      s?.destroy();
    }
  });
  // node-usb has no "wait forever" (a timeout of 0 cancels at once), so reads wait IDLE ms and,
  // if the phone said nothing, end as "Cancelled": that's just quiet, so read again. Every read
  // gets a handler at once: when the link drops they all fail, and an unwatched one would crash.
  // Failing much faster than IDLE, over and over, means the phone is gone.
  const IDLE = 10_000;
  const read = () => {
    const p = d.transferIn(inEp.endpointNumber, FRAME, IDLE);
    p.catch(() => {});
    return { p, at: Date.now() };
  };
  const reads = Array.from({ length: 4 }, read);
  let fast = 0;
  try {
    while (alive) {
      const { p, at } = reads.shift()!;
      let r: any;
      try {
        r = await p;
      } catch (e: any) {
        if (!/cancel/i.test(e?.message ?? "")) throw e;
        fast = Date.now() - at < IDLE / 2 ? fast + 1 : 0;
        if (fast > 8) throw e;
        reads.push(read());
        continue;
      }
      fast = 0;
      if (r.status !== "ok") throw new Error(r.status); // before queueing another read: one left out would hold up the close
      reads.push(read());
      if (r.data?.byteLength) onData(Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength));
    }
  } finally {
    stop();
    // the device can't close with a read still out; but never wait forever, or the watcher would
    // think this tunnel still runs and never start the next one
    await Promise.race([Promise.allSettled(reads.map((x) => x.p)), new Promise((r) => setTimeout(r, IDLE + 2000))]);
    await Promise.race([d.close().catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(`
  ${c.lime("fshare")} ${c.dim(`v${PKG_VERSION}`)}  fast file transfer between this computer and your phone

  ${c.bold("Usage")}   fshare [files or folders…] [options]

  ${c.bold("Connect")} USB: plug in an Android phone (USB debugging on) and open the app
          Wi-Fi: press ${c.bold("q")}, then scan the QR code in the app

  ${c.bold("While running")}
          drop files or folders into the terminal + Enter   send them to the phone (asks first)
          ${c.bold("q")}   show the Wi-Fi QR code
          ${c.bold("x")}   cancel all transfers (partial files are deleted)

  ${c.bold("Options")}
          -o <dir>     where received files go (default ~/Downloads)
          -p <port>    port to listen on (default 4747)
          --new-pair   forget paired phones (they scan the QR again)
`);
    return;
  }
  const flag = (f: string) => {
    const i = args.indexOf(f);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  // ~/Downloads is the standard location on macOS, Windows and most Linux desktops
  const outDir = path.resolve(flag("-o") ?? path.join(os.homedir(), "Downloads"));
  const port = Number(flag("-p") ?? 4747);

  const shared: Shared[] = [];
  let nextId = 0; // ids stay unique when files are removed from the list
  const ui = new UI();
  // Shared files are pushed: every connected phone downloads them by itself.
  const expandAll = (paths: string[]) =>
    paths.flatMap((p) => {
      try {
        return [{ p, files: expand(p) }];
      } catch (e: any) {
        ui.log(`  ${c.red("!")} ${p}: ${e.code === "ENOENT" ? "not found" : (e.code ?? e.message)}`);
        return [];
      }
    });
  const add = (paths: string[]) => {
    for (const { p, files } of expandAll(paths)) {
      for (const f of files) shared.push({ id: nextId++, path: f.rel, size: f.size, abs: f.abs });
      const size = fmt(files.reduce((s, f) => s + f.size, 0));
      ui.log(`  ${c.cyan("↓")} Sending   ${path.basename(p)}  ${c.dim(`${files.length} file${files.length === 1 ? "" : "s"} · ${size}`)}`);
    }
  };
  // dropped into the terminal: ask first, since a drop is easy to do by accident
  const stage = (paths: string[]) => {
    const found = expandAll(paths);
    const count = found.reduce((n, x) => n + x.files.length, 0);
    if (!count) return found.length && ui.log(c.dim("  Nothing to send (empty folder)"));
    ui.pending = {
      label: found.length === 1 ? path.basename(found[0].p) : `${path.basename(found[0].p)} and ${found.length - 1} more`,
      count,
      size: found.reduce((n, x) => n + x.files.reduce((m, f) => m + f.size, 0), 0),
      commit: () => add(found.map((x) => x.p)),
    };
  };
  const answer = (yes: boolean) => {
    const p = ui.pending!;
    ui.pending = null;
    if (yes) p.commit();
    else ui.log(c.dim(`  Not sent: ${p.label}`));
  };

  let wifiUrl = "";
  fs.rmSync(PARTS, { recursive: true, force: true }); // parts from an earlier session can't be resumed
  const token = pairToken(args.includes("--new-pair"));
  if (args.includes("--new-pair")) args.splice(args.indexOf("--new-pair"), 1);
  const server = createServer({ token, outDir, shared, ui });
  server.on("connection", (s) => s.setNoDelay(true));
  server.listen(port, "0.0.0.0", () => {
    const at = (server.address() as any).port;
    wifiUrl = `http://${lanIp()}:${at}/?t=${token}`;
    const row = (k: string, v: string) => console.log(`  ${c.dim(k.padEnd(9))} ${v}`);
    console.log(`\n  ${c.lime("fshare")} ${c.dim(`v${PKG_VERSION}`)}\n`);
    row("Saves to", home(outDir));
    row("Wi-Fi", `${lanIp()}:${at} ${c.dim("· press q for the QR code")}`);
    row("USB", c.dim("plug in an Android phone and open the app"));
    console.log();
    add(args);
    ui.redraw();
    const adbReady = new Set<string>();
    watchUsb(at, ui, adbReady);
    watchAccessory(at, adbReady);
  });
  server.on("error", (e: any) => {
    console.error(e.code === "EADDRINUSE" ? `  port ${port} is busy (another fshare running?). Try -p 0` : e);
    process.exit(1);
  });

  setInterval(() => ui.tick(0.5), 500).unref();
  const commands: Record<string, () => void> = {
    q: () =>
      qrcode.generate(wifiUrl, { small: true }, (q: string) =>
        ui.log(`\n${q.replace(/^/gm, "  ")}  ${c.dim("Scan in the app (Use Wi-Fi instead) or open")} ${wifiUrl}\n`),
      ),
    x: () => {
      if (!ui.active.size) ui.log(c.dim("  Nothing to cancel"));
      for (const a of ui.active) a.cancel();
    },
  };
  const quit = () => {
    ui.redraw();
    ui.done = true;
    ui.redraw();
    console.log(c.dim("  Bye 👋"));
    process.exit(0);
  };
  if (!process.stdin.isTTY) {
    // piped input: plain lines
    readline.createInterface({ input: process.stdin }).on("line", (l) => {
      l = l.trim();
      (commands[l] ?? (() => l && add(parsePaths(l))))();
    });
    return;
  }
  // Raw keys: q / x act right away on an empty prompt; anything else (a dropped path) is typed
  // into the prompt line and added on Enter.
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk === "\x1b" && ui.pending) answer(false); // Esc
    if (chunk.startsWith("\x1b")) return ui.redraw(); // arrow keys etc.
    for (const ch of chunk) {
      if (ch === "\x03" || ch === "\x04") return quit();
      if (ui.pending) {
        if (/[yY\r\n]/.test(ch)) answer(true);
        else if (/[nN]/.test(ch)) answer(false);
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const l = ui.input.trim();
        ui.input = "";
        ui.redraw();
        if (l) (commands[l] ?? (() => stage(parsePaths(l))))();
      } else if (ch === "\x7f" || ch === "\b") ui.input = ui.input.slice(0, -1);
      else if (ch === "\x15")
        ui.input = ""; // ctrl+u
      else if (!ui.input && commands[ch.toLowerCase()] && chunk.length === 1) commands[ch.toLowerCase()]();
      else if (ch >= " ") ui.input += ch;
    }
    ui.redraw();
  });
}

// run as a command (also through npm's bin symlink), not when imported by the tests
const entry = process.argv[1] && fs.realpathSync(process.argv[1]);
if (entry === fileURLToPath(import.meta.url)) main();
