import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const expandHome = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

// Split a line of paths dropped into the terminal: 'quotes', "quotes" and back\ slash escapes.
export function parsePaths(line: string): string[] {
  const out: string[] = [];
  let cur = "",
    quote = "",
    any = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = "";
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      any = true;
    } else if (ch === "\\" && i + 1 < line.length) {
      cur += line[++i];
      any = true;
    } else if (ch === " " || ch === "\t") {
      if (any || cur) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (any || cur) out.push(cur);
  return out;
}

// A file or folder as a flat list of files; folder contents keep "folder/sub/file" paths.
export function expand(p: string): { rel: string; abs: string; size: number }[] {
  const abs = path.resolve(expandHome(p));
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

// Where an uploaded name goes inside outDir. Rejects anything escaping it, and never overwrites:
// "a.jpg" becomes "a (1).jpg". `taken` holds names reserved by uploads still being written.
export function safeDest(outDir: string, name: string, taken = new Set<string>()): string | null {
  const root = path.resolve(outDir);
  const dest = path.resolve(root, name.replace(/\\/g, "/").replace(/^\/+/, ""));
  if (!dest.startsWith(root + path.sep)) return null;
  const { dir, name: stem, ext } = path.parse(dest);
  let p = dest;
  for (let i = 1; fs.existsSync(p) || taken.has(p); i++) p = path.join(dir, `${stem} (${i})${ext}`);
  return p;
}
