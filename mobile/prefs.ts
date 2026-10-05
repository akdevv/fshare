// Small JSON settings file: save folder (Android), the laptop pairing, phones paired over Wi-Fi,
// and this phone's own pairing secret.
import { File, Paths } from 'expo-file-system';

export type Prefs = {
  saveDir?: string;
  token?: string;
  lan?: string;
  theme?: 'system' | 'light' | 'dark';
  myToken?: string;
  myId?: string;
  onboarded?: boolean;
  hidden?: boolean; // not listed on other phones, and they can't ask to pair
  peers?: SavedPeer[];
};

// a phone paired over Wi-Fi; `base` is where it was last seen (its address can change)
export type SavedPeer = { id: string; name: string; token: string; base: string };

const f = new File(Paths.document, '.fshare-prefs.json');

export function readPrefs(): Prefs {
  try {
    return JSON.parse(f.textSync());
  } catch {
    return {};
  }
}

export function writePrefs(p: Prefs) {
  f.write(JSON.stringify({ ...readPrefs(), ...p }));
}
