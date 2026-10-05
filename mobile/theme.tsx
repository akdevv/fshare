import { createContext, use, useMemo, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import * as Haptics from 'expo-haptics';
import type { Ionicons } from '@expo/vector-icons';
import { readPrefs, writePrefs } from './prefs';

// Material 3-style tonal palette: an accent, a soft "container" version of it, and stepped surfaces.
export type Theme = {
  scheme: 'light' | 'dark';
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  line: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  onAccent: string;
  accentSoft: string;
  onAccentSoft: string;
  red: string;
  redSoft: string;
  amber: string;
  backdrop: string;
};

const dark: Theme = {
  scheme: 'dark',
  bg: '#000000',
  surface: '#111211',
  surface2: '#1B1C1A',
  surface3: '#262724',
  line: '#2E302C',
  text: '#F2F3EE',
  dim: '#9A9D94',
  faint: '#5F625B',
  accent: '#C6F36A',
  onAccent: '#121A00',
  accentSoft: '#26330B',
  onAccentSoft: '#DDF8A8',
  red: '#FF8A7E',
  redSoft: '#3A1714',
  amber: '#FFCB5C',
  backdrop: 'rgba(0,0,0,0.72)',
};

const light: Theme = {
  scheme: 'light',
  bg: '#F6F7F2',
  surface: '#FFFFFF',
  surface2: '#EDEFE7',
  surface3: '#E2E5DA',
  line: '#D9DCD0',
  text: '#131510',
  dim: '#5C6057',
  faint: '#A0A499',
  accent: '#4B6B04',
  onAccent: '#FFFFFF',
  accentSoft: '#DAF4A6',
  onAccentSoft: '#1B2A00',
  red: '#C4362B',
  redSoft: '#FCE3DF',
  amber: '#B57A12',
  backdrop: 'rgba(18,20,14,0.38)',
};

export type ThemePref = 'system' | 'light' | 'dark';
const Pref = createContext<{ pref: ThemePref; setPref: (p: ThemePref) => void }>({ pref: 'system', setPref: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, set] = useState<ThemePref>(() => readPrefs().theme ?? 'system');
  const setPref = (p: ThemePref) => {
    set(p);
    writePrefs({ theme: p });
  };
  return <Pref value={{ pref, setPref }}>{children}</Pref>;
}

export const useThemePref = () => use(Pref);

export function useTheme(): Theme {
  const { pref } = use(Pref);
  const system = useColorScheme();
  return (pref === 'system' ? system : pref) === 'light' ? light : dark;
}

// styles that depend on the theme, rebuilt only when light/dark flips
export function useStyles<T>(make: (t: Theme) => T): [T, Theme] {
  const t = useTheme();
  return [useMemo(() => make(t), [t]), t];
}

// Android: the system's own crisp haptic primitives (what the keyboard uses), not the
// vibration motor that impactAsync drives, which feels mushy on most Android phones.
const android = process.env.EXPO_OS === 'android';
const A = (type: Haptics.AndroidHaptics) => () => Haptics.performAndroidHapticsAsync(type).catch(() => {});
export const haptic = {
  tap: android ? A(Haptics.AndroidHaptics.Virtual_Key) : () => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light),
  select: android ? A(Haptics.AndroidHaptics.Segment_Tick) : () => Haptics.selectionAsync(),
  toggle: (on: boolean) =>
    android
      ? A(on ? Haptics.AndroidHaptics.Toggle_On : Haptics.AndroidHaptics.Toggle_Off)()
      : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid),
  success: android ? A(Haptics.AndroidHaptics.Confirm) : () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
  reject: android ? A(Haptics.AndroidHaptics.Reject) : () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning),
  error: android ? A(Haptics.AndroidHaptics.Reject) : () => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error),
};

export const fmt = (b: number) =>
  b >= 1e9 ? `${(b / 1e9).toFixed(2)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.ceil(b / 1e3))} KB`;

export const rate = (bps: number) => `${(bps / 1e6).toFixed(1)} MB/s`;

export function eta(seconds: number) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.ceil(seconds)}s left`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min left`;
  return `${(seconds / 3600).toFixed(1)} h left`;
}

export function fileIcon(name: string): keyof typeof Ionicons.glyphMap {
  const ext = name.split('.').pop()!.toLowerCase();
  if (/^(jpe?g|png|gif|heic|webp|bmp|svg)$/.test(ext)) return 'image-outline';
  if (/^(mp4|mov|mkv|avi|webm|m4v)$/.test(ext)) return 'film-outline';
  if (/^(mp3|m4a|wav|flac|aac|ogg)$/.test(ext)) return 'musical-notes-outline';
  if (/^(zip|rar|7z|tar|gz|dmg|apk)$/.test(ext)) return 'archive-outline';
  if (/^(pdf|docx?|txt|md|xlsx?|pptx?|csv)$/.test(ext)) return 'document-text-outline';
  return 'document-outline';
}
