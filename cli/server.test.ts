// HTTP server round-trips: list, download with resume, uploads with resume and cancel.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, parsePaths, safeDest, expand } from "./fshare.ts";

assert.deepEqual(parsePaths(`/a/my\\ file.txt '/b/x y' "/c/z" /d`), ["/a/my file.txt", "/b/x y", "/c/z", "/d"]);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fshare-"));
const out = path.join(tmp, "out");
assert.equal(safeDest(out, "../evil"), null);
assert.equal(safeDest(out, "/etc/passwd"), path.join(out, "etc/passwd"));

fs.mkdirSync(path.join(tmp, "dir/sub"), { recursive: true });
fs.writeFileSync(path.join(tmp, "dir/sub/a.bin"), (await import("node:crypto")).randomBytes(3_000_000));
const files = expand(path.join(tmp, "dir"));
assert.deepEqual(
  files.map((f) => f.rel),
  ["dir/sub/a.bin"],
);

const shared = files.map((f, id) => ({ id, path: f.rel, size: f.size, abs: f.abs }));
const server = createServer({ token: "tok", outDir: out, shared, name: "Test Mac", partsDir: path.join(tmp, "parts") }).listen(
  0,
  "0.0.0.0",
);
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

assert.equal((await fetch(`${base}/list?t=nope`)).status, 403);
// USB pairing hands out the token over loopback only
assert.equal(await (await fetch(`${base}/pair`)).text(), "tok");
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;
if (lan) assert.equal((await fetch(`http://${lan}:${(server.address() as any).port}/pair`)).status, 403);
assert.equal(decodeURIComponent((await fetch(`${base}/list?t=tok`)).headers.get("x-fshare-name")!), "Test Mac");
assert.deepEqual(await (await fetch(`${base}/list?t=tok`)).json(), [{ id: 0, path: "dir/sub/a.bin", size: 3_000_000 }]);
const got = Buffer.from(await (await fetch(`${base}/file/0?t=tok`)).arrayBuffer());
// each phone gets each file once: after a full download it drops off that phone's list only
await (await fetch(`${base}/file/0?t=tok&c=phoneA`)).arrayBuffer();
const listFor = async (c: string) => (await fetch(`${base}/list?t=tok&c=${c}`)).json();
for (let i = 0; i < 50 && (await listFor("phoneA")).length; i++) await new Promise((r) => setTimeout(r, 10)); // marked once the send finishes
assert.deepEqual(await listFor("phoneA"), []);
assert.equal((await (await fetch(`${base}/list?t=tok&c=phoneB`)).json()).length, 1);
assert.ok(got.equals(fs.readFileSync(files[0].abs)));
// resume from an offset
const part = await fetch(`${base}/file/0?t=tok`, { headers: { range: "bytes=1000000-" } });
assert.equal(part.status, 206);
assert.equal(part.headers.get("content-range"), "bytes 1000000-2999999/3000000");
assert.ok(Buffer.from(await part.arrayBuffer()).equals(got.subarray(1000000)));
const etag = part.headers.get("etag")!;
// unsharing removes it from the list, never from disk
const extra = { id: 9, path: "x.bin", size: 3_000_000, abs: files[0].abs };
shared.push(extra);
assert.equal((await fetch(`${base}/file/9?t=tok`, { method: "DELETE" })).status, 200);
assert.ok(!shared.includes(extra) && fs.existsSync(files[0].abs));
assert.ok(etag && part.headers.get("last-modified"));
assert.equal((await fetch(`${base}/file/0?t=tok`, { headers: { range: "bytes=10-", "if-range": etag } })).status, 206);
assert.equal((await fetch(`${base}/file/0?t=tok`, { headers: { range: "bytes=10-", "if-range": '"stale"' } })).status, 200);

for (let i = 0; i < 2; i++) {
  const r = await fetch(`${base}/upload?t=tok&name=${encodeURIComponent("pics/a.bin")}`, { method: "PUT", body: got });
  assert.equal(r.status, 200);
}
assert.ok(fs.readFileSync(path.join(out, "pics/a.bin")).equals(got));
assert.ok(fs.existsSync(path.join(out, "pics/a (1).bin")));
assert.equal((await fetch(`${base}/upload?t=tok&name=..%2Fx`, { method: "PUT", body: "x" })).status, 400);

// resumable upload: send 1 MB, drop the connection (pause), ask what arrived, send the rest
const http0 = await import("node:http");
const blob = (await import("node:crypto")).randomBytes(2_000_000);
const q = (o: string) => `${base}/upload?t=tok&id=job1&name=resume.bin&size=${blob.length}&offset=${o}`;
await new Promise<void>((done) => {
  const r = http0.request(q("0"), { method: "PUT", headers: { "content-length": String(blob.length) } });
  r.on("error", () => {});
  r.write(blob.subarray(0, 1_000_000));
  setTimeout(() => {
    r.destroy();
    setTimeout(done, 100);
  }, 100);
});
const { received } = await (await fetch(`${base}/upload?t=tok&id=job1`)).json();
assert.equal(received, 1_000_000);
assert.ok(!fs.existsSync(path.join(out, "resume.bin")));
assert.equal((await fetch(q(String(received)), { method: "PUT", body: blob.subarray(received) })).status, 200);
assert.ok(fs.readFileSync(path.join(out, "resume.bin")).equals(blob));
assert.equal((await fetch(q("5"), { method: "PUT", body: "x" })).status, 409); // offset beyond what arrived
assert.equal((await fetch(`${base}/upload?t=tok&id=job1`, { method: "DELETE" })).status, 200);

// cancelled upload: partial file must be gone
const http = await import("node:http");
await new Promise<void>((done) => {
  const r = http.request(`${base}/upload?t=tok&name=cut.bin`, { method: "PUT", headers: { "content-length": "1000000" } });
  r.on("error", () => {});
  r.write(Buffer.alloc(100_000));
  setTimeout(() => {
    assert.ok(fs.existsSync(path.join(out, "cut.bin.fshare-part")));
    r.destroy();
    setTimeout(done, 100);
  }, 100);
});
assert.deepEqual(fs.readdirSync(out).sort(), ["pics", "resume.bin"]);

server.close();
fs.rmSync(tmp, { recursive: true });
console.log("ok");
