// HTTP server round-trips over the sealed protocol: list, download with resume, uploads with resume,
// and everything an eavesdropper or a forger might try.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { createServer, parsePaths, safeDest, expand } from "./fshare.ts";
import { opener, open, seal, sealedSize, sealFile, sign } from "./seal.ts";

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
const sent: string[][] = [];
const saved: [string, string][] = [];
const server = createServer({
  token: "tok",
  outDir: out,
  shared,
  name: "Test Mac",
  partsDir: path.join(tmp, "parts"),
  received: (dest, from) => saved.push([path.relative(out, dest), from]),
  control: { key: "ctl", send: (paths) => (sent.push(paths), { files: 1, size: 3, to: [], missing: [] }) },
}).listen(0, "0.0.0.0");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as any).port}`;

// a request the app would make: signed with the token, last param &s=
const u = (p: string, method = "GET", token = "tok") => {
  const q = `${p}${p.includes("?") ? "&" : "?"}c=phone`;
  return `${base}${q}&s=${sign(token, `${method} ${q}`)}`;
};
const list = async (c = "phone") => {
  const q = `/list?c=${c}`;
  const r = await fetch(`${base}${q}&s=${sign("tok", `GET ${q}`)}`);
  return JSON.parse(open("tok", await r.text())!.toString());
};
const unseal = async (b: Buffer) => Buffer.concat(await Readable.from([b]).pipe(opener("tok")).toArray());
const sealed = async (f: string, salt = Buffer.alloc(7, 1)) =>
  Buffer.concat(await Readable.from(sealFile("tok", f, fs.statSync(f).size, salt)).toArray());

// unsigned, signed with the wrong token, or tampered with after signing: all refused
assert.equal((await fetch(`${base}/list?t=tok`)).status, 403);
assert.equal((await fetch(u("/list", "GET", "nope"))).status, 403);
assert.equal((await fetch(u("/list").replace("c=phone", "c=other"))).status, 403);
assert.equal((await fetch(u("/list", "DELETE"))).status, 403); // signed for another method
// USB pairing hands out the token over loopback only
assert.equal(await (await fetch(`${base}/pair`)).text(), "tok");
const lan = Object.values(os.networkInterfaces())
  .flat()
  .find((a) => a?.family === "IPv4" && !a.internal)?.address;
if (lan) assert.equal((await fetch(`http://${lan}:${(server.address() as any).port}/pair`)).status, 403);
// the list is sealed: no names or paths in the clear
const raw = await (await fetch(u("/list"))).text();
assert.ok(!raw.includes("a.bin") && !raw.includes("Test Mac"));
assert.deepEqual(await list(), { name: "Test Mac", kind: "laptop", files: [{ id: 0, path: "dir/sub/a.bin", size: 3_000_000 }] });

const orig = fs.readFileSync(files[0].abs);
const wire = Buffer.from(await (await fetch(u("/file/0"))).arrayBuffer());
assert.equal(wire.length, sealedSize(orig.length));
assert.ok(!wire.includes(orig.subarray(0, 64))); // nothing readable on the wire
const got = await unseal(wire);
assert.ok(got.equals(orig));
// each phone gets each file once: after a full download it drops off that phone's list only
for (let i = 0; i < 50 && (await list()).files.length; i++) await new Promise((r) => setTimeout(r, 10)); // marked once the send finishes
assert.deepEqual((await list()).files, []);
assert.equal((await list("phoneB")).files.length, 1);
// resume from any offset into the sealed bytes: the same file always seals the same way
const part = await fetch(u("/file/0"), { headers: { range: "bytes=1000001-" } });
assert.equal(part.status, 206);
assert.equal(part.headers.get("content-range"), `bytes 1000001-${wire.length - 1}/${wire.length}`);
assert.ok(Buffer.from(await part.arrayBuffer()).equals(wire.subarray(1000001)));
const head3 = await fetch(u("/file/0"), { headers: { range: "bytes=3-" } }); // inside the salt
assert.ok(Buffer.from(await head3.arrayBuffer()).equals(wire.subarray(3)));
const etag = part.headers.get("etag")!;
// unsharing removes it from the list, never from disk
const extra = { id: 9, path: "x.bin", size: 3_000_000, abs: files[0].abs };
shared.push(extra);
assert.equal((await fetch(u("/file/9", "DELETE"), { method: "DELETE" })).status, 200);
assert.ok(!shared.includes(extra) && fs.existsSync(files[0].abs));
assert.ok(etag && part.headers.get("last-modified"));
assert.equal((await fetch(u("/file/0"), { headers: { range: "bytes=10-", "if-range": etag } })).status, 206);
assert.equal((await fetch(u("/file/0"), { headers: { range: "bytes=10-", "if-range": '"stale"' } })).status, 200);

// `fshare send` from another terminal: loopback and the key, nothing else
const ctl = (key?: string, host = "127.0.0.1") =>
  fetch(`http://${host}:${(server.address() as any).port}/control/send`, {
    method: "POST",
    headers: key ? { "x-fshare-control": key } : {},
    body: JSON.stringify({ paths: ["/a", "/b"] }),
  });
assert.equal((await ctl()).status, 403);
assert.equal((await ctl("wrong")).status, 403);
if (lan) assert.equal((await ctl("ctl", lan)).status, 403); // right key, but not from this computer
assert.deepEqual(await (await ctl("ctl")).json(), { files: 1, size: 3, to: [], missing: [] });
assert.deepEqual(sent, [["/a", "/b"]]);

// the opener refuses anything cut short, tampered with, or sealed with another key
await assert.rejects(unseal(wire.subarray(0, wire.length - 65552)));
const bent = Buffer.from(wire);
bent[100] ^= 1;
await assert.rejects(unseal(bent));
const other = Buffer.concat(await Readable.from(sealFile("nope", files[0].abs, orig.length, Buffer.alloc(7))).toArray());
await assert.rejects(unseal(other));
for (const n of [0, 1, 65536, 65537, 131072]) {
  const f = path.join(tmp, `n${n}`);
  fs.writeFileSync(f, Buffer.alloc(n, 7));
  const w = await sealed(f);
  assert.equal(w.length, sealedSize(n));
  assert.ok((await unseal(w)).equals(Buffer.alloc(n, 7)), `round trip ${n}`);
}

// resumable upload: send part of it, drop the connection (pause), ask what arrived, send the rest
const http = await import("node:http");
fs.writeFileSync(path.join(tmp, "blob"), (await import("node:crypto")).randomBytes(2_000_000));
const blob = await sealed(path.join(tmp, "blob"));
const name = seal("tok", "pics/resume.bin");
const q = (o: number, id = "job1", size = blob.length) => u(`/upload?id=${id}&name=${name}&size=${size}&offset=${o}`, "PUT");
await new Promise<void>((done) => {
  const r = http.request(q(0), { method: "PUT", headers: { "content-length": String(blob.length) } });
  r.on("error", () => {});
  r.write(blob.subarray(0, 1_000_000));
  setTimeout(() => {
    r.destroy();
    setTimeout(done, 100);
  }, 100);
});
const { received } = await (await fetch(u("/upload?id=job1"))).json();
assert.equal(received, 1_000_000);
assert.ok(!fs.existsSync(path.join(out, "pics/resume.bin")));
assert.equal((await fetch(q(received), { method: "PUT", body: blob.subarray(received) })).status, 200);
assert.ok(fs.readFileSync(path.join(out, "pics/resume.bin")).equals(fs.readFileSync(path.join(tmp, "blob"))));
assert.deepEqual(saved, [["pics/resume.bin", "your phone"]]); // no x-fshare-client header in this test
// a replay of the finished upload isn't saved twice
assert.equal((await fetch(q(0), { method: "PUT", body: blob })).status, 200);
assert.ok(!fs.existsSync(path.join(out, "pics/resume (1).bin")));
assert.equal((await fetch(q(5, "job2"), { method: "PUT", body: "x" })).status, 409); // offset beyond what arrived
assert.equal((await fetch(u("/upload?id=job2", "DELETE"), { method: "DELETE" })).status, 200);
// a name that isn't sealed with the token, or escapes the folder, is refused
const badName = (n: string) => u(`/upload?id=job3&name=${n}&size=1&offset=0`, "PUT");
assert.equal((await fetch(badName("pics%2Fx"), { method: "PUT", body: "x" })).status, 400);
assert.equal((await fetch(badName(seal("tok", "../x")), { method: "PUT", body: "x" })).status, 400);
// garbage that arrives whole is rejected and leaves nothing behind
const junk = Buffer.alloc(500, 3);
assert.equal(
  (await fetch(u(`/upload?id=job4&name=${seal("tok", "junk.bin")}&size=500&offset=0`, "PUT"), { method: "PUT", body: junk })).status,
  400,
);
assert.ok(!fs.existsSync(path.join(out, "junk.bin")));

// cancelled upload: partial file must be gone from the output folder
await new Promise<void>((done) => {
  const r = http.request(q(0, "job5", 1_000_000), { method: "PUT", headers: { "content-length": "1000000" } });
  r.on("error", () => {});
  r.write(Buffer.alloc(100_000));
  setTimeout(() => {
    r.destroy();
    setTimeout(done, 100);
  }, 100);
});
assert.deepEqual(fs.readdirSync(out).sort(), ["pics"]);
assert.deepEqual(fs.readdirSync(path.join(out, "pics")), ["resume.bin"]);

server.close();
fs.rmSync(tmp, { recursive: true });
console.log("ok");
