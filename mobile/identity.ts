// Who this phone is: a name to show, an id the laptop uses to hand each file over once, and the
// secret other phones need to send to us. Made once, kept in prefs.
import * as Crypto from 'expo-crypto';
import { readPrefs, writePrefs } from './prefs';
import { myName } from './modules/fshare-peer';

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

// laptops see it on the next request; nearby phones once fshare restarts its announcement
export function rename(name: string) {
  me.name = name;
  writePrefs({ name });
}
