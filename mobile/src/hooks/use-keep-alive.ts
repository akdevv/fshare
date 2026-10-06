import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { Peer } from '../../modules/fshare-peer';
import { askToNotify } from '../lib/notify';

const IDLE_MS = 5 * 60_000;

// Minimized, fshare keeps running while connected: on Android a foreground service with an
// ongoing notification, on iOS a background task while files move. After 5 idle minutes in the
// background it lets go; opened again, it picks back up.
export function useKeepAlive({
  enabled,
  busy,
  title,
  text,
  progress,
}: {
  enabled: boolean;
  busy: boolean;
  title: string;
  text: string;
  progress: number;
}) {
  const [idle, setIdle] = useState(false);

  useEffect(() => {
    askToNotify();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      if (state === 'active') setIdle(false);
      else if (state === 'background') timer = setTimeout(() => setIdle(true), IDLE_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
      Peer?.background(false, '', '', -1);
    };
  }, []);

  useEffect(() => {
    if (!Peer) return;
    if (!enabled || (idle && !busy)) Peer.background(false, '', '', -1);
    else Peer.background(true, title, text, busy ? progress : -1);
  }, [enabled, idle, busy, title, text, progress]);
}
