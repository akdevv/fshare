// End-to-end encryption between fshare devices. The pairing token (from the QR code, the USB
// cable, or phone pairing) never crosses Wi-Fi; it's the key. Seal.kt and Seal.swift in the app
// follow the same spec byte for byte:
//
//   keys    root = HMAC-SHA256("fshare-e2e-1", token), enc = HMAC(root, "enc"), mac = HMAC(root, "mac")
//   sign    hex(HMAC(mac, msg)[0..16]). A request is signed as "METHOD /path?query" and sent with &s=<sig>
//   seal    base64url(nonce12 ‖ AES-256-GCM(enc, data) ‖ tag16), for small messages (lists, names, tokens)
//   files   salt7 ‖ chunk0 ‖ chunk1 ‖ …  Each chunk is ≤64 KiB of the file, AES-256-GCM(enc) ‖ tag16, with
//           nonce salt7 ‖ last(0|1) ‖ index(u32 BE). Always at least one chunk; the last one is flagged,
//           so a file cut short or reordered fails to open.
//   pairing (phone to phone) ECDH P-256, z = shared x-coordinate:
//           secret = hex(HMAC("fshare-pair-1", z)), used as a token for the exchange;
//           code = u32 BE(HMAC(mac of secret, "code")[0..4]) mod 1e6, shown on both phones to compare
import crypto from "node:crypto";
import fs from "node:fs";
import { Transform } from "node:stream";

export const CH = 65536;
const TAG = 16;
export const SALT = 7;

const hmac = (k: string | Buffer, m: string | Buffer) => crypto.createHmac("sha256", k).update(m).digest();

export function keys(token: string) {
  const root = hmac("fshare-e2e-1", token);
  return { enc: hmac(root, "enc"), mac: hmac(root, "mac") };
}

export const sign = (token: string, msg: string) => hmac(keys(token).mac, msg).subarray(0, 16).toString("hex");

// "GET /list?c=1&s=…" → the part that was signed, if the signature checks out
export function verify(token: string, method: string, url: string): boolean {
  const m = /[?&]s=([0-9a-f]{32})$/.exec(url);
  if (!m) return false;
  const want = Buffer.from(sign(token, `${method} ${url.slice(0, m.index)}`), "hex");
  return crypto.timingSafeEqual(want, Buffer.from(m[1], "hex"));
}

export function seal(token: string, data: string | Buffer): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keys(token).enc, iv);
  return Buffer.concat([iv, c.update(data), c.final(), c.getAuthTag()]).toString("base64url");
}

export function open(token: string, sealed: string): Buffer | null {
  try {
    const b = Buffer.from(sealed, "base64url");
    if (b.length < 12 + TAG) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", keys(token).enc, b.subarray(0, 12));
    d.setAuthTag(b.subarray(b.length - TAG));
    return Buffer.concat([d.update(b.subarray(12, b.length - TAG)), d.final()]);
  } catch {
    return null;
  }
}

export const chunks = (size: number) => (size === 0 ? 1 : Math.ceil(size / CH));
export const sealedSize = (size: number) => SALT + size + TAG * chunks(size);

const nonce = (salt: Buffer, i: number, last: boolean) => {
  const n = Buffer.alloc(12);
  salt.copy(n, 0, 0, SALT);
  n[SALT] = last ? 1 : 0;
  n.writeUInt32BE(i, 8);
  return n;
};

function sealChunk(enc: Buffer, salt: Buffer, i: number, last: boolean, plain: Buffer) {
  const c = crypto.createCipheriv("aes-256-gcm", enc, nonce(salt, i, last));
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
}

function openChunk(enc: Buffer, salt: Buffer, i: number, last: boolean, sealed: Buffer) {
  const d = crypto.createDecipheriv("aes-256-gcm", enc, nonce(salt, i, last));
  d.setAuthTag(sealed.subarray(sealed.length - TAG));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()]);
}

// The same file always seals to the same bytes (salt from its path, size and mtime), so a paused
// download resumes with an HTTP Range into the sealed stream. `from` is an offset in that stream.
export function fileSalt(token: string, abs: string, st: { size: number; mtimeMs: number }) {
  return hmac(keys(token).mac, `file\0${abs}\0${st.size}\0${Math.floor(st.mtimeMs)}`).subarray(0, SALT);
}

export async function* sealFile(token: string, abs: string, size: number, salt: Buffer, from = 0) {
  const { enc } = keys(token);
  const n = chunks(size);
  let i = 0,
    skip = 0;
  if (from < SALT) yield salt.subarray(from);
  else {
    i = Math.floor((from - SALT) / (CH + TAG));
    skip = (from - SALT) % (CH + TAG);
  }
  const fh = await fs.promises.open(abs);
  try {
    const buf = Buffer.alloc(CH);
    for (; i < n; i++) {
      const want = Math.min(CH, size - i * CH);
      const { bytesRead } = await fh.read(buf, 0, want, i * CH);
      if (bytesRead !== want) throw new Error("file changed while sending");
      const out = sealChunk(enc, salt, i, i === n - 1, buf.subarray(0, want));
      yield skip ? out.subarray(skip) : out;
      skip = 0;
    }
  } finally {
    await fh.close();
  }
}

// sealed stream in, the file out; errors on anything tampered with, reordered or cut short
export function opener(token: string) {
  const { enc } = keys(token);
  let salt: Buffer | null = null,
    buf: Buffer = Buffer.alloc(0),
    i = 0;
  return new Transform({
    transform(b: Buffer, _, cb) {
      buf = buf.length ? Buffer.concat([buf, b]) : b;
      try {
        if (!salt) {
          if (buf.length < SALT) return cb();
          salt = Buffer.from(buf.subarray(0, SALT));
          buf = buf.subarray(SALT);
        }
        // a whole chunk with more after it can't be the last one
        while (buf.length > CH + TAG) {
          this.push(openChunk(enc, salt, i++, false, buf.subarray(0, CH + TAG)));
          buf = buf.subarray(CH + TAG);
        }
        cb();
      } catch {
        cb(new Error("not sealed with this key"));
      }
    },
    flush(cb) {
      try {
        if (!salt || buf.length < TAG) throw new Error();
        this.push(openChunk(enc, salt, i, true, buf));
        cb();
      } catch {
        cb(new Error("not sealed with this key"));
      }
    },
  });
}

// phone pairing, for tests (the laptop doesn't pair with phones this way)
export function pairSecret(ecdh: crypto.ECDH, theirPub: string) {
  const z = ecdh.computeSecret(Buffer.from(theirPub, "base64url"));
  const secret = hmac("fshare-pair-1", z).toString("hex");
  const code = String(hmac(keys(secret).mac, "code").readUInt32BE(0) % 1_000_000).padStart(6, "0");
  return { secret, code };
}
