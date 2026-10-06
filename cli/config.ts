import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CONFIG = path.join(os.homedir(), ".config", "fshare");

// cli/ when run from source, cli/dist/ when built: either way, the folder with package.json
const here = path.dirname(fileURLToPath(import.meta.url));
export const CLI_DIR = [here, path.dirname(here)].find((d) => fs.existsSync(path.join(d, "package.json"))) ?? here;

export const readVersion = (): string => {
  try {
    return JSON.parse(fs.readFileSync(path.join(CLI_DIR, "package.json"), "utf8")).version;
  } catch {
    return "?";
  }
};
export const VERSION = readVersion();
