// The laptop's HTTP server. Every request except /pair and /control/send is signed with the
// pairing token, and everything sent back is sealed (see seal.ts):
//   GET    /pair                 the token, loopback only (the USB cable)
//   GET    /list                 sealed { name, kind, files: [{ id, path, size }] }
//   GET    /file/:id             the file, sealed; Range works on the sealed bytes
//   DELETE /file/:id             unshare it
//   GET|PUT|DELETE /upload?id=   resumable upload of a sealed file; name= is sealed too
//   POST   /control/send         `fshare send` from another terminal on this computer
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { safeDest } from "./files.ts";
import { fileSalt, open, opener, seal, sealedSize, sealFile, verify } from "./seal.ts";
import { type Active, c, fmt, home, speed, UI } from "./term.ts";

// the phone app checks this to tell an fshare from before encryption apart
export const PROTOCOL = "3";
export const PARTS = path.join(os.tmpdir(), "fshare-parts");
export const KEEP_MS = 5 * 60_000; // how long a stopped upload waits for the phone to resume it
const CHUNK = 1 << 20;
const OPENING = ".fshare-part";

// delivered: app ids that downloaded it already, so each phone gets each file once
export type Shared = { id: number; path: string; size: number; abs: string; delivered?: Set<string> };
export type SendResult = { files: number; size: number; to: string[]; missing: string[] };

type Options = {
  token: string;
  outDir: string;
  shared: Shared[];
  ui?: UI;
  name?: string;
  partsDir?: string;
  received?: (dest: string, from: string) => void;
  control?: { key: string; send: (paths: string[]) => SendResult };
};

// Parts nobody resumed in time. `busy`: parts being written right now.
export function sweepParts(dir: string, busy: Set<string>, keep = KEEP_MS, now = Date.now()) {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const f = path.join(dir, n);
    try {
      if (!busy.has(f) && now - fs.statSync(f).mtimeMs > keep) fs.rmSync(f, { force: true });
    } catch {}
  }
}

// "Ashish's MacBook Air" on macOS, the hostname elsewhere
export function computerName(): string {
  if (process.platform === "darwin")
    try {
      return execFileSync("scutil", ["--get", "ComputerName"]).toString().trim();
    } catch {}
  return os.hostname().replace(/\.local$/, "");
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const sameSecret = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const sizeOf = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return 0;
  }
};
const reply = (res: http.ServerResponse, code: number, body = "", headers: http.OutgoingHttpHeaders = {}) => {
  res.writeHead(code, headers).end(body);
};
const json = (res: http.ServerResponse, code: number, body: unknown) =>
  reply(res, code, JSON.stringify(body), { "content-type": "application/json" });

export function createServer(opts: Options) {
  const { token, outDir, shared, partsDir = PARTS } = opts;
  const name = opts.name ?? computerName();
  const ui = opts.ui ?? new UI();
  const taken = new Set<string>();
  const writing = new Set<string>();
  const finished = new Set<string>(); // saved upload ids: a replayed upload isn't saved twice
  const partOf = (id: string) => path.join(partsDir, id.replace(/[^\w-]/g, "").slice(0, 80) || "x");
  const sender = (req: http.IncomingMessage) => {
    const h = req.headers["x-fshare-client"];
    return (typeof h === "string" && open(token, h)?.toString()) || undefined;
  };
  const took = (t0: number, size: number) => c.dim(`${fmt(size)} · ${speed(size / ((Date.now() - t0) / 1000 || 1))}`);

  const track = (stream: NodeJS.ReadableStream, label: string, total: number, dir: Active["dir"], cancel: () => void, start = 0) => {
    const a: Active = { name: label, dir, done: start, total, rate: 0, last: start, cancel };
    ui.active.add(a);
    stream.on("data", (b: Buffer) => {
      a.done += b.length;
    });
    return () => ui.active.delete(a);
  };

  // Loopback alone isn't enough: a phone on the USB cable arrives on loopback too. The key is in
  // ~/.config/fshare/running.json, which only this user can read.
  async function control(req: http.IncomingMessage, res: http.ServerResponse, local: boolean) {
    const key = req.headers["x-fshare-control"];
    if (!local || typeof key !== "string" || !sameSecret(key, opts.control!.key)) return reply(res, 403);
    try {
      const { paths } = JSON.parse(Buffer.concat(await req.toArray()).toString());
      json(res, 200, opts.control!.send(paths));
    } catch {
      reply(res, 400);
    }
  }

  function list(req: http.IncomingMessage, res: http.ServerResponse, phone: string | null, local: boolean) {
    ui.seen(sender(req) ?? "Phone", local);
    const files = shared.filter((s) => !(phone && s.delivered?.has(phone))).map(({ id, path, size }) => ({ id, path, size }));
    reply(res, 200, seal(token, JSON.stringify({ name, kind: "laptop", files })), {
      "content-type": "text/plain",
      "x-fshare-version": PROTOCOL,
    });
  }

  function unshare(res: http.ServerResponse, id: number) {
    const i = shared.findIndex((s) => s.id === id);
    if (i >= 0) {
      ui.log(`  ${c.dim(`− Unshared  ${shared[i].path}`)}`);
      shared.splice(i, 1);
    }
    reply(res, 200, "ok");
  }

  // A paused download resumes with "Range: bytes=N-". iOS only keeps resume data for files with an
  // ETag or Last-Modified, and resumes with If-Range: when the file changed since, it's sent whole.
  async function download(req: http.IncomingMessage, res: http.ServerResponse, f: Shared, phone: string | null) {
    const st = fs.statSync(f.abs);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const modified = st.mtime.toUTCString();
    const total = sealedSize(st.size);
    const ifRange = req.headers["if-range"];
    const fresh = !ifRange || ifRange === etag || ifRange === modified;
    const from = fresh ? Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? "")?.[1] ?? 0) : 0;
    if (from > 0 && from >= total) return reply(res, 416, "", { "content-range": `bytes */${total}` });
    res.writeHead(from ? 206 : 200, {
      "content-type": "application/octet-stream",
      "content-length": total - from,
      "accept-ranges": "bytes",
      etag,
      "last-modified": modified,
      ...(from && { "content-range": `bytes ${from}-${total - 1}/${total}` }),
    });
    const src = Readable.from(sealFile(token, f.abs, st.size, fileSalt(token, f.abs, st), from));
    const untrack = track(src, f.path, total, "down", () => res.destroy(), from);
    const t0 = Date.now();
    try {
      await pipeline(src, res);
    } catch {
      untrack();
      return ui.log(`  ${c.yellow("‖")} Stopped   ${f.path}  ${c.dim("paused or cancelled on the phone")}`);
    }
    untrack();
    if (phone) (f.delivered ??= new Set()).add(phone);
    ui.log(`  ${c.green("✓")} Sent      ${f.path}  ${took(t0, f.size)}`);
  }

  // The sealed file is written to a part file first, then opened into outDir once it's all here.
  // A stopped upload keeps its part for KEEP_MS, and the phone carries on with ?offset=.
  async function upload(req: http.IncomingMessage, res: http.ServerResponse, id: string, url: URL) {
    const label = open(token, url.searchParams.get("name") ?? "")?.toString() ?? "";
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const size = Number(url.searchParams.get("size") ?? 0);
    const part = partOf(id);
    if (!label || !safeDest(outDir, label)) return reply(res, 400, "bad name");
    if (finished.has(id)) return reply(res, 200, "ok"); // a replay, or a retry after a lost reply
    if (offset > sizeOf(part)) return json(res, 409, { received: sizeOf(part) });

    fs.mkdirSync(partsDir, { recursive: true });
    writing.add(part);
    if (offset) fs.truncateSync(part, offset);
    else fs.rmSync(part, { force: true });
    let cancelled = false;
    const cancel = () => {
      cancelled = true;
      req.destroy();
    };
    const untrack = track(req, label, size, "up", cancel, offset);
    const t0 = Date.now();
    try {
      await pipeline(req, fs.createWriteStream(part, { flags: "a", highWaterMark: CHUNK }));
      if (sizeOf(part) !== size) throw new Error("incomplete");
    } catch {
      untrack();
      writing.delete(part);
      if (cancelled) {
        fs.rmSync(part, { force: true });
        ui.log(`  ${c.red("✗")} Cancelled ${label}`);
      } else ui.log(`  ${c.yellow("‖")} Paused    ${label}  ${c.dim(`${fmt(sizeOf(part))} of ${fmt(size)} kept for 5 min`)}`);
      return;
    }
    writing.delete(part);
    untrack();

    const dest = safeDest(outDir, label, taken)!;
    taken.add(dest);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(fs.createReadStream(part, { highWaterMark: CHUNK }), opener(token), fs.createWriteStream(dest + OPENING));
      fs.renameSync(dest + OPENING, dest);
    } catch {
      // arrived whole but didn't open: not from a device with this key, or damaged on the way
      fs.rmSync(dest + OPENING, { force: true });
      ui.log(`  ${c.red("✗")} Rejected  ${label}  ${c.dim("didn't decrypt")}`);
      return reply(res, 400, "bad data");
    } finally {
      taken.delete(dest);
      fs.rmSync(part, { force: true });
    }
    finished.add(id);
    reply(res, 200, "ok");
    ui.log(`  ${c.green("✓")} Received  ${home(dest)}  ${took(t0, size - offset)}`);
    opts.received?.(dest, sender(req) ?? "your phone");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, "http://x");
    const local = LOOPBACK.has(req.socket.remoteAddress ?? "");
    if (url.pathname === "/pair") return local ? reply(res, 200, token) : reply(res, 403);
    if (url.pathname === "/control/send" && req.method === "POST" && opts.control) return control(req, res, local);
    // the header tells an app from before encryption that this fshare is newer
    if (!verify(token, req.method ?? "", req.url!)) return reply(res, 403, "bad signature", { "x-fshare-version": PROTOCOL });

    const phone = url.searchParams.get("c");
    if (req.method === "GET" && url.pathname === "/list") return list(req, res, phone, local);

    const file = /^\/file\/(\d+)$/.exec(url.pathname);
    if (file && req.method === "DELETE") return unshare(res, Number(file[1]));
    if (file && req.method === "GET") {
      const f = shared.find((s) => s.id === Number(file[1]));
      return f ? download(req, res, f, phone) : reply(res, 404);
    }

    const id = url.pathname === "/upload" ? url.searchParams.get("id") : null;
    if (id && req.method === "GET") return json(res, 200, { received: sizeOf(partOf(id)) });
    if (id && req.method === "DELETE") {
      fs.rmSync(partOf(id), { force: true });
      return reply(res, 200, "ok");
    }
    if (id && req.method === "PUT") return upload(req, res, id, url);
    reply(res, 404);
  });
  const sweep = setInterval(() => sweepParts(partsDir, writing), 60_000).unref();
  server.on("close", () => clearInterval(sweep));
  return server;
}
