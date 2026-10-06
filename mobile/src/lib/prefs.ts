import { File, Paths } from 'expo-file-system';

export type Prefs = {
  saveDir?: string; // Android: the folder granted in the system picker
  token?: string; // the laptop's pairing token
  lan?: string; // the laptop's Wi-Fi address
  theme?: 'system' | 'light' | 'dark';
  myToken?: string; // what other phones need to send to this one
  myId?: string;
  name?: string; // this phone's name, when changed from the system's
  onboarded?: boolean;
  hidden?: boolean; // not listed on other phones, which then can't ask to pair
  notify?: boolean; // finished-transfer notifications; on unless false
  keepAlive?: boolean; // keep running while minimized; on unless false
  peers?: SavedPeer[];
};

// A phone paired over Wi-Fi. `base` is where it was last seen; its address can change.
// `e2e`: paired with the code check (1.0.8+). Older pairings swapped tokens in the clear.
export type SavedPeer = { id: string; name: string; token: string; base: string; e2e?: boolean };

const file = new File(Paths.document, '.fshare-prefs.json');
let cache: Prefs | null = null; // read once; the device check reads prefs every 2 s

export function readPrefs(): Prefs {
  if (!cache)
    try {
      cache = JSON.parse(file.textSync()) as Prefs;
    } catch {
      cache = {};
    }
  return cache;
}

export function writePrefs(p: Prefs) {
  cache = { ...readPrefs(), ...p };
  file.write(JSON.stringify(cache));
}
