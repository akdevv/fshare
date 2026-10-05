// Who this phone is: a name to show, an id the laptop uses to hand each file over once, and the
// secret other phones need to send to us. Made once, kept in prefs.
import * as Crypto from 'expo-crypto';
import { readPrefs, writePrefs } from './prefs';
import { myName, Peer } from './modules/fshare-peer';

function load() {
  let { myToken, myId } = readPrefs();
  if (!myToken || !myId) {
    myToken = Crypto.randomUUID().replace(/-/g, '');
    myId = Crypto.randomUUID();
    writePrefs({ myToken, myId });
  }
  return { token: myToken, id: myId, name: readPrefs().name || myName };
}

export const me = load();

// A request to another device, signed with its token (cli/seal.ts): `c` says which phone this
// is, `s` proves we hold the token without sending it. No native module (Expo Go): unsigned, refused.
export function signed(d: { base: string; token: string }, p: string, method = 'GET') {
  const q = `${p}${p.includes('?') ? '&' : '?'}c=${me.id}`;
  return `${d.base}${q}&s=${Peer?.sign(d.token, `${method} ${q}`) ?? ''}`;
}

// who's asking, sealed for the device we're asking
export const client = (token: string) => ({ 'x-fshare-client': Peer?.seal(token, me.name) ?? '' });

// a device's sealed /list reply: its name and kind, and (laptops) the files it's sharing
export function openList(token: string, body: string) {
  const text = Peer?.open(token, body);
  if (!text) return null;
  return JSON.parse(text) as { name: string; kind: 'laptop' | 'phone'; files: { id: number; path: string; size: number }[] };
}

// laptops see it on the next request; nearby phones once fshare restarts its announcement
export function rename(name: string) {
  me.name = name;
  writePrefs({ name });
}
