import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function reveal(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const cmd = { darwin: "open", win32: "explorer" }[process.platform as string] ?? "xdg-open";
  execFile(cmd, [dir], () => {});
}

export function notify(title: string, body: string) {
  if (process.platform === "darwin")
    execFile("osascript", ["-e", `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`], () => {});
  else if (process.platform === "linux") execFile("notify-send", [title, body], () => {});
}

// One notification a moment after the last file of a batch lands, so a folder of 200 photos is
// "Received 200 files", not 200 notifications.
export function batchNotify(show: (title: string, body: string) => void, wait = 1500) {
  let names: string[] = [],
    from = "",
    timer: NodeJS.Timeout | undefined;
  return (dest: string, who: string) => {
    names.push(path.basename(dest));
    from = who;
    clearTimeout(timer);
    timer = setTimeout(() => {
      show(names.length === 1 ? `Received ${names[0]}` : `Received ${names.length} files`, `From ${from}`);
      names = [];
    }, wait);
  };
}
