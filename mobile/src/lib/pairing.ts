import { Peer, SERVER_PORT, type Found } from '../../modules/fshare-peer';
import { me } from './identity';
import type { SavedPeer } from './prefs';

// Pairs with a phone found nearby. Both phones swap ECDH keys and show the same 6-digit code,
// `onCode` gets ours, and the other phone's owner compares the two before accepting. Each phone's
// token then travels sealed with the shared secret.
export async function pairWith(f: Found, signal: AbortSignal, onCode: (code: string) => void): Promise<SavedPeer> {
  if (!Peer) throw new Error('no peer module');
  const base = `http://${f.host}:${f.port}`;
  const hello = await fetch(`${base}/hello?name=${encodeURIComponent(me.name)}&port=${SERVER_PORT}&id=${me.id}&pub=${Peer.pairStart()}`, {
    method: 'POST',
    signal,
  });
  if (!hello.ok) throw new Error('refused');
  const { id, pub } = await hello.json();
  const { secret, code } = Peer.pairFinish(pub);
  onCode(code);
  const r = await fetch(`${base}/hello?wait=${id}&token=${Peer.seal(secret, me.token)}`, { method: 'POST', signal });
  const token = r.ok && Peer.open(secret, await r.text());
  if (!token) throw new Error('declined');
  return { id: f.id || f.host, name: f.name, token, base, e2e: true };
}
