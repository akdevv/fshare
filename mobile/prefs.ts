// Small JSON settings file: save folder (Android), the laptop pairing, and this phone's own pairing secret.
import { File, Paths } from 'expo-file-system';

export type Prefs = {
  saveDir?: string;
  token?: string;
  lan?: string;
  theme?: 'system' | 'light' | 'dark';
  myToken?: string;
  myId?: string;
  onboarded?: boolean;
};

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
