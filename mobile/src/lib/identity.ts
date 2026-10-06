// Who this phone is: a name, an id the laptop uses to hand each file over once, and the token
// other phones need to send here. Made once, then kept in prefs.
import * as Crypto from 'expo-crypto';
import { myName, Peer } from '../../modules/fshare-peer';
import { readPrefs, writePrefs } from './prefs';

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

// A request to another device, signed with its token (see cli/seal.ts): `c` says which phone this
// is, and `s` proves we hold the token without sending it. Without the native module (Expo Go)
// it goes unsigned, and is refused.
export function signed(d: { base: string; token: string }, path: string, method = 'GET') {
  const q = `${path}${path.includes('?') ? '&' : '?'}c=${me.id}`;
  return `${d.base}${q}&s=${Peer?.sign(d.token, `${method} ${q}`) ?? ''}`;
}

// who's asking, sealed for the device being asked
export const client = (token: string) => ({ 'x-fshare-client': Peer?.seal(token, me.name) ?? '' });

export type ListReply = { name: string; kind: 'laptop' | 'phone'; files: { id: number; path: string; size: number }[] };

// a device's /list reply, if it's sealed with this token
export function openList(token: string, body: string): ListReply | null {
  const text = Peer?.open(token, body);
  return text ? (JSON.parse(text) as ListReply) : null;
}

// Laptops see the new name on their next request, nearby phones once the new announcement goes out.
export function rename(name: string) {
  me.name = name;
  writePrefs({ name });
  Peer?.setName(name);
}
