#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import qrcode from "qrcode-terminal";
import { CONFIG, VERSION } from "./config.ts";
import { batchNotify, notify, reveal } from "./desktop.ts";
import { expand, expandHome, parsePaths } from "./files.ts";
import { uninstall, update } from "./install.ts";
import { createServer, PARTS, type SendResult, type Shared } from "./server.ts";
import { c, files, fmt, home, UI } from "./term.ts";
import { watchAccessory, watchAdb } from "./usb.ts";

const PORT = 4747;
// where `fshare send` in another terminal finds the fshare that's running: its port and a key
const RUNNING = path.join(CONFIG, "running.json");

function help() {
  const cmd = (s: string) => c.bold(s.padEnd(22));
  console.log(`
  ${c.lime("fshare")} ${c.dim(`v${VERSION}`)}  fast file transfer between this computer and your phone

  ${c.bold("Commands")}
    ${cmd("fshare [files…]")}start, and send these to your phone
    ${cmd("fshare send <files…>")}send from any terminal (starts fshare if it isn't running)
    ${cmd("fshare update")}get the latest version from GitHub
    ${cmd("fshare uninstall")}remove fshare from this computer

  ${c.bold("Connect")}
    USB     plug in an Android phone and open the app
    Wi-Fi   press ${c.bold("q")}, then scan the QR code in the app

  ${c.bold("While it runs")}
    drop files or folders + Enter   send them (asks first)
    ${c.bold("o")}   open the folder received files go to
    ${c.bold("q")}   show the Wi-Fi QR code
    ${c.bold("x")}   cancel all transfers (partial files are deleted)

  ${c.bold("Options")}
    -o <dir>     where received files go (default ~/Downloads)
    -p <port>    port to listen on (default ${PORT})
    --new-pair   forget paired phones (they scan the QR again)
`);
}

// Kept across runs, so a phone that paired once reconnects (over USB too) without scanning again.
function pairToken(reset: boolean): string {
  const f = path.join(CONFIG, "token");
  if (!reset)
    try {
      return fs.readFileSync(f, "utf8").trim();
    } catch {}
  const token = crypto.randomBytes(16).toString("hex");
  fs.mkdirSync(CONFIG, { recursive: true });
  fs.writeFileSync(f, token, { mode: 0o600 });
  return token;
}

function lanIp(): string {
  const all = Object.entries(os.networkInterfaces())
    .flatMap(([name, addrs]) => (addrs ?? []).map((a) => ({ name, ...a })))
    .filter((a) => a.family === "IPv4" && !a.internal);
  // Wi-Fi or Ethernet over VPN and Docker bridges
  return (all.find((a) => /^(en|wl|eth)/.test(a.name)) ?? all[0])?.address ?? "127.0.0.1";
}

// Hands the paths to the fshare that's running. False when there's none to hand them to.
async function sendToRunning(paths: string[]): Promise<boolean> {
  let running: { port: number; key: string };
  try {
    running = JSON.parse(fs.readFileSync(RUNNING, "utf8"));
  } catch {
    return false;
  }
  let r: Response;
  try {
    r = await fetch(`http://127.0.0.1:${running.port}/control/send`, {
      method: "POST",
      headers: { "x-fshare-control": running.key },
      body: JSON.stringify({ paths }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    return false; // left behind by an fshare that didn't quit cleanly
  }
  if (!r.ok) return false;
  const res: SendResult = await r.json();
  for (const m of res.missing) console.log(`  ${c.red("!")} ${path.relative(process.cwd(), m) || m}: not found`);
  if (!res.files) {
    if (!res.missing.length) console.log(c.dim("  Nothing to send (empty folder)"));
    process.exitCode = 1;
    return true;
  }
  const to = res.to.length ? res.to.join(" and ") : "your phone when it connects";
  console.log(`  ${c.cyan("↓")} Sending ${c.bold(files(res.files))} ${c.dim(`· ${fmt(res.size)}`)} to ${c.bold(to)}`);
  console.log(c.dim("    Progress shows in the fshare window."));
  return true;
}

function start(args: string[]) {
  const flag = (f: string) => {
    const i = args.indexOf(f);
    return i < 0 ? undefined : args.splice(i, 2)[1];
  };
  const outDir = path.resolve(flag("-o") ?? path.join(os.homedir(), "Downloads"));
  const port = Number(flag("-p") ?? PORT);
  const newPair = args.includes("--new-pair");
  if (newPair) args.splice(args.indexOf("--new-pair"), 1);

  const ui = new UI();
  const shared: Shared[] = [];
  let nextId = 0;

  const expandAll = (paths: string[], missing: string[] = []) =>
    paths.flatMap((p) => {
      try {
        return [{ p, files: expand(p) }];
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        ui.log(`  ${c.red("!")} ${p}: ${code === "ENOENT" ? "not found" : (code ?? (e as Error).message)}`);
        missing.push(p);
        return [];
      }
    });
  // Shared files are pushed: every connected phone downloads them by itself.
  const share = (paths: string[]): SendResult => {
    const res: SendResult = { files: 0, size: 0, to: ui.connected(), missing: [] };
    for (const { p, files: found } of expandAll(paths, res.missing)) {
      const size = found.reduce((n, f) => n + f.size, 0);
      for (const f of found) shared.push({ id: nextId++, path: f.rel, size: f.size, abs: f.abs });
      res.files += found.length;
      res.size += size;
      ui.log(`  ${c.cyan("↓")} Sending   ${path.basename(p)}  ${c.dim(`${files(found.length)} · ${fmt(size)}`)}`);
    }
    return res;
  };
  // dropped into the terminal: asks first, since a drop is easy to do by accident
  const stage = (paths: string[]) => {
    const found = expandAll(paths);
    const count = found.reduce((n, x) => n + x.files.length, 0);
    if (!count) return found.length && ui.log(c.dim("  Nothing to send (empty folder)"));
    const first = path.basename(found[0].p);
    ui.pending = {
      label: found.length === 1 ? first : `${first} and ${found.length - 1} more`,
      count,
      size: found.reduce((n, x) => n + x.files.reduce((m, f) => m + f.size, 0), 0),
      commit: () => share(found.map((x) => x.p)),
    };
  };
  const answer = (yes: boolean) => {
    const p = ui.pending!;
    ui.pending = null;
    if (yes) p.commit();
    else ui.log(c.dim(`  Not sent: ${p.label}`));
  };

  fs.rmSync(PARTS, { recursive: true, force: true }); // an earlier session's parts can't be resumed
  const token = pairToken(newPair);
  const control = crypto.randomBytes(16).toString("hex");
  const server = createServer({ token, outDir, shared, ui, received: batchNotify(notify), control: { key: control, send: share } });
  let wifiUrl = "";
  server.on("connection", (s) => s.setNoDelay(true));
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(e.code === "EADDRINUSE" ? `  port ${port} is busy (another fshare running?). Try -p 0` : e);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0", () => {
    const at = (server.address() as { port: number }).port;
    wifiUrl = `http://${lanIp()}:${at}/?t=${token}`;
    const row = (k: string, v: string) => console.log(`  ${c.dim(k.padEnd(9))} ${v}`);
    console.log(`\n  ${c.lime("fshare")} ${c.dim(`v${VERSION}`)}\n`);
    row("Saves to", home(outDir));
    row("Wi-Fi", `${lanIp()}:${at} ${c.dim("· press q for the QR code")}`);
    row("USB", c.dim("plug in an Android phone and open the app"));
    console.log();

    fs.mkdirSync(CONFIG, { recursive: true });
    fs.writeFileSync(RUNNING, JSON.stringify({ port: at, key: control, pid: process.pid }), { mode: 0o600 });
    process.on("exit", () => {
      try {
        if (JSON.parse(fs.readFileSync(RUNNING, "utf8")).pid === process.pid) fs.rmSync(RUNNING);
      } catch {}
    });
    for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

    share(args);
    ui.redraw();
    const adbReady = new Set<string>();
    watchAdb(at, ui, adbReady);
    watchAccessory(at, adbReady);
  });
  setInterval(() => ui.tick(0.5), 500).unref();

  const commands: Record<string, () => void> = {
    q: () =>
      qrcode.generate(wifiUrl, { small: true }, (code: string) =>
        ui.log(`\n${code.replace(/^/gm, "  ")}  ${c.dim("Scan in the app (Use Wi-Fi instead) or open")} ${wifiUrl}\n`),
      ),
    o: () => {
      reveal(outDir);
      ui.log(c.dim(`  Opened ${home(outDir)}`));
    },
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
    readline.createInterface({ input: process.stdin }).on("line", (line) => {
      line = line.trim();
      if (commands[line]) commands[line]();
      else if (line) share(parsePaths(line));
    });
    return;
  }
  // q, o and x act at once on an empty prompt; anything else (a dropped path) is typed into the
  // prompt and sent on Enter
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    if (chunk === "\x1b" && ui.pending) answer(false);
    if (chunk.startsWith("\x1b")) return ui.redraw(); // Esc, arrow keys
    for (const ch of chunk) {
      if (ch === "\x03" || ch === "\x04") return quit();
      if (ui.pending) {
        if (/[yY\r\n]/.test(ch)) answer(true);
        else if (/[nN]/.test(ch)) answer(false);
        continue;
      }
      const key = ch.toLowerCase();
      if (ch === "\r" || ch === "\n") {
        const line = ui.input.trim();
        ui.input = "";
        ui.redraw();
        if (commands[line]) commands[line]();
        else if (line) stage(parsePaths(line));
      } else if (ch === "\x7f" || ch === "\b") ui.input = ui.input.slice(0, -1);
      else if (ch === "\x15")
        ui.input = ""; // ctrl+u
      else if (!ui.input && commands[key] && chunk.length === 1) commands[key]();
      else if (ch >= " ") ui.input += ch;
    }
    ui.redraw();
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "help" || args.includes("-h") || args.includes("--help")) return help();
  if (args[0] === "update") return update();
  if (args[0] === "uninstall") return uninstall();
  if (args[0] === "send") {
    args.shift();
    if (!args.length) {
      console.log(`  Usage: ${c.bold("fshare send <files or folders…>")}`);
      process.exitCode = 1;
      return;
    }
    if (await sendToRunning(args.map((p) => path.resolve(expandHome(p))))) return;
    console.log(c.dim("  fshare isn't running here yet; starting it."));
  }
  start(args);
}

main();
