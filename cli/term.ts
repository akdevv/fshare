import os from "node:os";
import path from "node:path";
import { styleText } from "node:util";

export const c = {
  dim: (s: string) => styleText("dim", s),
  bold: (s: string) => styleText("bold", s),
  green: (s: string) => styleText("green", s),
  red: (s: string) => styleText("red", s),
  cyan: (s: string) => styleText("cyan", s),
  yellow: (s: string) => styleText("yellow", s),
  magenta: (s: string) => styleText("magenta", s),
  lime: (s: string) => styleText(["bold", "greenBright"], s),
};

export const fmt = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`;
export const speed = (bytesPerSec: number) => `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
export const files = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
export const home = (p: string) => p.replace(os.homedir(), "~");

const eta = (s: number) =>
  !isFinite(s) || s <= 0
    ? ""
    : s < 60
      ? `${Math.ceil(s)}s left`
      : s < 3600
        ? `${Math.ceil(s / 60)} min left`
        : `${(s / 3600).toFixed(1)} h left`;

const bar = (f: number, width: number) => {
  const k = Math.round(Math.max(0, Math.min(1, f)) * width);
  return c.lime("━".repeat(k)) + c.dim("─".repeat(width - k));
};

const shorten = (s: string, n: number) =>
  s.length > n ? s.slice(0, Math.ceil(n / 2) - 1) + "…" + s.slice(s.length - Math.floor(n / 2)) : s;

// eslint-disable-next-line no-control-regex -- matching terminal color codes is the point
const ESC = /\x1b\[[0-9;]*m/y;

// Cut a styled string to n visible columns. A live line that wrapped would break the in-place
// redraw and leave copies of itself behind.
export function clip(s: string, n: number): string {
  let out = "",
    visible = 0;
  for (let i = 0; i < s.length; i++) {
    ESC.lastIndex = i;
    const esc = ESC.exec(s);
    if (esc) {
      out += esc[0];
      i += esc[0].length - 1;
      continue;
    }
    if (visible >= n) return out + "\x1b[0m";
    out += s[i];
    visible++;
  }
  return out;
}

export type Active = { name: string; dir: "up" | "down"; done: number; total: number; rate: number; last: number; cancel: () => void };
type Client = { name: string; usb: boolean; seen: number };

// Files dropped into the terminal wait here until you confirm sending them.
export type Pending = { label: string; count: number; size: number; commit: () => void };

// History scrolls up; below it a live area is redrawn in place:
//   ● Galaxy S23 · USB cable
//   ↓ clip.mp4  ━━━━━━━━━━━──────  62%  1.2 GB of 2.0 GB  34.1 MB/s  25s left
//   › drop files here + Enter   o folder · q Wi-Fi QR · x cancel · ctrl+c quit
export class UI {
  pending: Pending | null = null;
  active = new Set<Active>();
  clients = new Map<string, Client>();
  input = "";
  done = false;
  private drawn = 0;
  private readonly tty = !!process.stdout.isTTY;

  log(msg: string) {
    this.clear();
    console.log(msg);
    this.draw();
  }

  redraw() {
    this.clear();
    this.draw();
  }

  seen(name: string, usb: boolean) {
    const key = `${name}|${usb}`;
    const known = this.clients.has(key);
    this.clients.set(key, { name, usb, seen: Date.now() });
    if (!known) this.redraw();
  }

  connected = () => [...new Set([...this.clients.values()].map((p) => p.name))];

  // every half second: speeds, phones that stopped polling, and the redraw that shows them
  tick(dt: number) {
    let changed = this.active.size > 0;
    for (const a of this.active) {
      a.rate = a.rate * 0.5 + ((a.done - a.last) / dt) * 0.5;
      a.last = a.done;
    }
    for (const [k, p] of this.clients)
      if (Date.now() - p.seen > 5000) {
        this.clients.delete(k);
        changed = true;
      }
    if (changed) this.redraw();
  }

  status(): string {
    if (!this.clients.size) return `  ${c.yellow("○")} ${c.dim("Waiting for a phone · plug it in, or press q to connect over Wi-Fi")}`;
    const phones = [...this.clients.values()].map(
      (p) => `${c.green("●")} ${c.bold(p.name)} ${c.dim(`· ${p.usb ? "USB cable" : "Wi-Fi"}`)}`,
    );
    return "  " + phones.join("   ");
  }

  progress(width: number): string | null {
    if (!this.active.size) return null;
    let total = 0,
      done = 0,
      rate = 0;
    const dirs = new Set<Active["dir"]>();
    for (const a of this.active) {
      total += a.total;
      done += a.done;
      rate += a.rate;
      dirs.add(a.dir);
    }
    const arrow = dirs.size > 1 ? c.cyan("⇅") : dirs.has("down") ? c.magenta("↓") : c.green("↑");
    const label = this.active.size === 1 ? path.basename([...this.active][0].name) : files(this.active.size);
    const f = total ? done / total : 0;
    const percent = String(Math.floor(f * 100)).padStart(3);
    const tail = `  ${percent}%  ${c.dim(`${fmt(done)} of ${fmt(total)}`)}  ${c.bold(speed(rate))}  ${c.dim(eta((total - done) / rate))}`;
    const room = Math.max(10, width - 70); // what's left for the name beside the bar and numbers
    return `  ${arrow} ${shorten(label, Math.min(32, room))}  ${bar(f, 20)}${tail}`;
  }

  confirm(): string | null {
    const p = this.pending;
    if (!p) return null;
    const names = this.connected();
    const to = names.length ? names.join(" and ") : "the next phone that connects";
    const what = p.count > 1 ? `${p.label} (${files(p.count)})` : p.label;
    const keys = `${c.lime("y")} ${c.dim("send ·")} ${c.bold("n")} ${c.dim("cancel")}`;
    return `  ${c.yellow("?")} Send ${c.bold(what)} ${c.dim(`· ${fmt(p.size)}`)} to ${c.bold(to)}?   ${keys}`;
  }

  private clear() {
    if (!this.drawn) return;
    process.stdout.write(`\r${this.drawn > 1 ? `\x1b[${this.drawn - 1}A` : ""}\x1b[J`);
    this.drawn = 0;
  }

  private draw() {
    if (!this.tty || this.done) return;
    const w = process.stdout.columns || 100;
    const prompt =
      this.confirm() ??
      (this.input
        ? `  ${c.cyan("›")} ${this.input.length > w - 6 ? "…" + this.input.slice(-(w - 7)) : this.input}`
        : `  ${c.cyan("›")} ${c.dim("drop files here + Enter")}   ${c.dim("o folder · q Wi-Fi QR · x cancel · ctrl+c quit")}`);
    const lines = ["", this.status(), this.progress(w), prompt].filter((l) => l !== null).map((l) => clip(l, w - 1));
    process.stdout.write(lines.join("\n"));
    if (!this.input && !this.pending) process.stdout.write("\r\x1b[4C"); // cursor right after "›"
    this.drawn = lines.length;
  }
}
