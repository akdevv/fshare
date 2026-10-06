import { useEffect, useRef, useState } from 'react';
import { NO_DEVICE, type Device } from '../lib/device';
import { client, openList, signed } from '../lib/identity';
import type { Remote } from './use-transfers';

export type Link = 'connecting' | 'online' | 'offline' | 'none';

// Polls the device every 2 s: whether it's reachable, its current name, and (laptops) the files
// it's sharing, handed to `onFiles`.
export function useLink(device: Device, onFiles: (files: Remote[]) => void) {
  const [link, setLink] = useState<Link>('connecting');
  const [name, setName] = useState(device.name);
  const [outdated, setOutdated] = useState(false); // the laptop runs an fshare from before encryption
  const files = useRef(onFiles);
  files.current = onFiles;

  useEffect(() => {
    setName(device.name);
    setOutdated(false);
    if (device.id === NO_DEVICE.id) return setLink('none');
    setLink('connecting');
    let alive = true;
    const poll = async () => {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(signed(device, '/list'), { signal: ctrl.signal, headers: client(device.token) });
        // an fshare from before encryption refuses signed requests without saying its version
        if (alive) setOutdated(r.status === 403 && Number(r.headers.get('x-fshare-version') ?? 0) < 3);
        if (!r.ok) throw new Error();
        const reply = openList(device.token, await r.text());
        if (!reply) throw new Error(); // not sealed with this token: not the device we paired with
        if (!alive) return;
        files.current(reply.files);
        setLink('online');
        if (reply.name) setName(reply.name);
      } catch {
        if (alive) setLink('offline');
      } finally {
        clearTimeout(timeout);
      }
    };
    poll();
    const timer = setInterval(poll, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [device.base, device.token]);

  return { link, name, outdated };
}
