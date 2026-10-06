// `fshare update` and `fshare uninstall`, for a copy installed with install.sh: a git clone in
// ~/.fshare (or $FSHARE_HOME), built in place.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_DIR, CONFIG, readVersion, VERSION } from "./config.ts";
import { c, home } from "./term.ts";

const INSTALL_HOME = path.resolve(process.env.FSHARE_HOME ?? path.join(os.homedir(), ".fshare"));
const INSTALL = "curl -fsSL https://raw.githubusercontent.com/akdevv/fshare/main/install.sh | sh";

const realpath = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
};

// the install's root, when this is the installed copy and not a development checkout
function installRoot(): string | null {
  const root = path.dirname(CLI_DIR);
  if (realpath(root) === realpath(INSTALL_HOME) && fs.existsSync(path.join(root, ".git"))) return root;
  console.log(`  ${c.yellow("!")} This fshare is at ${home(root)}, not installed with install.sh.`);
  console.log(c.dim(`    Install it with: ${INSTALL}`));
  process.exitCode = 1;
  return null;
}

export function update() {
  const root = installRoot();
  if (!root) return;
  try {
    console.log(c.dim("  Getting the latest from GitHub…"));
    // the same steps as install.sh, whatever state this copy is in
    execFileSync("git", ["-C", root, "fetch", "--quiet", "--depth", "1", "origin", "main"], { stdio: "inherit" });
    execFileSync("git", ["-C", root, "checkout", "--quiet", "--force", "FETCH_HEAD"], { stdio: "inherit" });
    execFileSync("npm", ["ci", "--prefix", CLI_DIR, "--no-audit", "--no-fund", "--loglevel=error"], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  } catch {
    console.log(`  ${c.red("✗")} Update failed. To start over: ${c.bold(`rm -rf ${home(root)} && ${INSTALL}`)}`);
    process.exitCode = 1;
    return;
  }
  const now = readVersion();
  console.log(
    now === VERSION
      ? `  ${c.green("✓")} Already up to date ${c.dim(`(v${now})`)}`
      : `  ${c.green("✓")} Updated ${c.dim(`v${VERSION} →`)} ${c.bold(`v${now}`)}`,
  );
}

export function uninstall() {
  const root = installRoot();
  if (!root) return;
  const bins = [process.env.FSHARE_BIN, "/usr/local/bin", path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin"];
  for (const dir of bins) {
    if (!dir) continue;
    const link = path.join(dir, "fshare");
    try {
      if (fs.lstatSync(link).isSymbolicLink() && fs.realpathSync(link).startsWith(root + path.sep)) fs.rmSync(link);
    } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(`  ${c.green("✓")} fshare is uninstalled`);
  console.log(c.dim(`    Your pairing is still in ${home(CONFIG)}; delete that folder too to forget your phones.`));
}
