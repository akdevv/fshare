// Drives a phone's peer server (Android's Kotlin or iOS's Swift, built by run.sh) the way other
// fshare devices do, using the laptop's implementation of the spec (cli/seal.ts) as the reference.
//   node drive.mts <work dir> <port> <server command…>
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import { open, opener, pairSecret, seal, sealFile, sign } from '../../../../cli/seal.ts';

const [dir, port, ...cmd] = process.argv.slice(2);
fs.rmSync(`${dir}/parts`, { recursive: true, force: true });
const plain = crypto.randomBytes(300_000);
fs.writeFileSync(`${dir}/plain.bin`, plain);
const nodeSealed = Buffer.concat(await Readable.from(sealFile('ptok', `${dir}/plain.bin`, plain.length, Buffer.alloc(7, 9))).toArray());
fs.writeFileSync(`${dir}/node.sealed`, nodeSealed);

const p = spawn(cmd[0], [...cmd.slice(1), dir, port]);
const events: any[] = [];
readline.createInterface({ input: p.stdout }).on('line', (l) => events.push(JSON.parse(l)));
p.stderr.pipe(process.stderr);
const wait = async (f: () => any) => {
  for (let i = 0; i < 200; i++) {
    const v = f();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
};
const base = `http://127.0.0.1:${port}`;
const u = (q: string, m = 'GET', t = 'ptok') => {
  q += '&c=node';
  return `${base}${q}&s=${sign(t, `${m} ${q}`)}`;
};
const results: [string, boolean][] = [];
const check = (k: string, b: boolean) => results.push([k, b]);
try {
  await wait(() => events.find((e) => e.event === 'ready'));
  check('opens a file Node sealed', fs.readFileSync(`${dir}/native.out`).equals(plain));
  const theirs = Buffer.concat(
    await Readable.from([fs.readFileSync(`${dir}/native.sealed`)])
      .pipe(opener('ptok'))
      .toArray(),
  );
  check('seals a file Node opens', theirs.equals(plain));

  check('unsigned request refused', (await fetch(`${base}/list?c=node`)).status === 403);
  check('wrong token refused', (await fetch(u('/list?x=1', 'GET', 'nope'))).status === 403);
  check('signed for another method refused', (await fetch(u('/list?x=1', 'DELETE'))).status === 403);
  const body = await (await fetch(u('/list?x=1'))).text();
  check('list is sealed', !body.includes('Test phone') && JSON.parse(open('ptok', body)!.toString()).name === 'Test phone');

  // pairing: swap keys, same code on both sides, tokens travel sealed
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const hi = await (
    await fetch(`${base}/hello?name=Node&port=1&id=nid&pub=${ecdh.getPublicKey().toString('base64url')}`, { method: 'POST' })
  ).json();
  const { secret, code } = pairSecret(ecdh, hi.pub);
  const r = await fetch(`${base}/hello?wait=${hi.id}&token=${seal(secret, 'nodetok')}`, { method: 'POST' });
  const req = events.find((e) => e.event === 'pairRequest');
  check('pair: same code on both phones', req?.code === code);
  check('pair: our token arrives sealed and opens', req?.token === 'nodetok');
  check('pair: their token comes back', open(secret, await r.text())?.toString() === 'ptok');
  check(
    "pair: step 2 can't be replayed",
    (await fetch(`${base}/hello?wait=${hi.id}&token=${seal(secret, 'x')}`, { method: 'POST' })).status === 403,
  );

  // a sealed upload, paused part way, then resumed
  const name = seal('ptok', 'photo.jpg');
  const q = (o: number, id = 'job1', size = nodeSealed.length) => u(`/upload?id=${id}&name=${name}&size=${size}&offset=${o}`, 'PUT');
  await new Promise<void>((done) => {
    const w = http.request(q(0), { method: 'PUT', headers: { 'content-length': String(nodeSealed.length) } });
    w.on('error', () => {});
    w.write(nodeSealed.subarray(0, 100_000));
    setTimeout(() => {
      w.destroy();
      setTimeout(done, 200);
    }, 200);
  });
  const { received } = await (await fetch(u('/upload?id=job1'))).json();
  check('upload: keeps what arrived', received === 100_000);
  check('upload: resumes', (await fetch(q(received), { method: 'PUT', body: nodeSealed.subarray(received) })).status === 200);
  const got = await wait(() => events.find((e) => e.event === 'received'));
  // handed to the app still sealed (it opens it straight into the save folder)
  const arrived = fs.readFileSync(new URL(got.uri));
  const opened = Buffer.concat(await Readable.from([arrived]).pipe(opener('ptok')).toArray());
  check('upload: handed over sealed, with its real name', got.name === 'photo.jpg' && arrived.equals(nodeSealed) && opened.equals(plain));
  const replay = await fetch(q(0), { method: 'PUT', body: nodeSealed });
  check("upload: a replay isn't saved twice", replay.status === 200 && events.filter((e) => e.event === 'received').length === 1);
  // junk of the right size arrives, but won't open (the app then throws it away)
  await fetch(u(`/upload?id=job2&name=${name}&size=500&offset=0`, 'PUT'), { method: 'PUT', body: Buffer.alloc(500, 1) });
  const junk = await wait(() => events.find((e) => e.event === 'received' && e.id === 'job2'));
  const refused = await Readable.from([fs.readFileSync(new URL(junk.uri))])
    .pipe(opener('ptok'))
    .toArray()
    .then(
      () => false,
      () => true,
    );
  check("upload: junk won't open", refused);
} catch (e) {
  check(`no errors (${e})`, false);
} finally {
  p.kill();
}
for (const [k, b] of results) console.log(`  ${b ? '✓' : '✗'} ${k}`);
process.exit(results.every(([, b]) => b) ? 0 : 1);
