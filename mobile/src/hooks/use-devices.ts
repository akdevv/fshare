// Which devices can be reached, and which one the main screen is on. Runs the phone's own server
// and Wi-Fi discovery, and checks every 2 s who answers: a laptop on the cable or Wi-Fi, a phone on
// the USB-C cable, and phones paired before.
import { useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { CABLE, Peer, type Found, type PairRequest } from '../../modules/fshare-peer';
import type { Device } from '../lib/device';
import { client, me, openList, signed } from '../lib/identity';
import { readPrefs, writePrefs, type SavedPeer } from '../lib/prefs';

// the laptop's port, tunnelled over the USB cable by adb
const USB = 'http://127.0.0.1:4747';
// when several answer, most preferred first: a cable beats Wi-Fi
const RANK = ['laptop-usb', 'cable', 'laptop-wifi'];

export const phoneDevice = (p: SavedPeer): Device => ({
  id: `phone-${p.id}`,
  name: p.name,
  base: p.base,
  token: p.token,
  kind: 'phone',
  via: 'wifi',
});

async function getText(url: string, ms = 1500) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// a device's name and kind, if it answers with this token
async function identify(base: string, token: string) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1500);
  try {
    const r = await fetch(signed({ base, token }, '/list'), { signal: ctrl.signal, headers: client(token) });
    // a laptop on an fshare from before encryption: still listed, so the main screen can say to update it
    if (r.status === 403 && !r.headers.get('x-fshare-version')) return { name: 'Laptop', kind: 'laptop' as const };
    if (!r.ok) return null;
    const reply = openList(token, await r.text());
    return reply && { name: reply.name || 'Device', kind: reply.kind === 'phone' ? ('phone' as const) : ('laptop' as const) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function useDevices({ scanning, onPairRequest }: { scanning: boolean; onPairRequest: (r: PairRequest) => void }) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [current, setCurrent] = useState<Device | null>(null);
  const [nearby, setNearby] = useState<Found[]>([]);
  const [saved, setSaved] = useState<SavedPeer[]>(() => readPrefs().peers ?? []);
  const [visible, setVisible] = useState(() => !readPrefs().hidden);
  const currentRef = useRef(current);
  currentRef.current = current;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;
  const pairRequest = useRef(onPairRequest);
  pairRequest.current = onPairRequest;

  const keep = (next: SavedPeer[]) => {
    savedRef.current = next;
    writePrefs({ peers: next });
    setSaved(next);
  };
  const remember = (p: SavedPeer) => keep([...savedRef.current.filter((x) => x.id !== p.id), p]);
  const forget = (p: SavedPeer) => {
    keep(savedRef.current.filter((x) => x.id !== p.id));
    setDevices((ds) => ds.filter((d) => d.id !== `phone-${p.id}`));
    if (currentRef.current?.id === `phone-${p.id}`) setCurrent(null);
  };
  // a phone just paired: remembered, listed, and returned to switch to
  const paired = (p: SavedPeer) => {
    remember(p);
    const d = phoneDevice(p);
    setDevices((ds) => [...ds.filter((x) => x.id !== d.id), d]);
    return d;
  };
  const changeVisible = (v: boolean) => {
    setVisible(v);
    writePrefs({ hidden: !v });
    Peer?.setVisible(v);
  };

  useEffect(() => {
    if (!Peer) return;
    Peer.start(me.token, me.name, me.id, !readPrefs().hidden);
    const subs = [
      // names are unique on the network; the id also catches a renamed phone coming back
      Peer.addListener('peerFound', (f) => {
        if (f.id !== me.id) setNearby((n) => [...n.filter((x) => x.name !== f.name && (!f.id || x.id !== f.id)), f]);
      }),
      Peer.addListener('peerLost', ({ name }) => setNearby((n) => n.filter((x) => x.name !== name))),
      Peer.addListener('pairRequest', (r) => pairRequest.current(r)),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  useEffect(() => {
    if (scanning && !currentRef.current) return; // scanning on purpose: don't yank them away
    let alive = true;
    const probe = async () => {
      const found: Device[] = [];
      // a cable pairs by itself: the other side hands its token only to the cable
      const usbToken = await getText(`${USB}/pair`);
      if (usbToken) {
        if (usbToken !== readPrefs().token) writePrefs({ token: usbToken });
        const id = await identify(USB, usbToken);
        found.push({ id: 'laptop-usb', name: id?.name ?? 'Laptop', base: USB, token: usbToken, kind: 'laptop', via: 'usb' });
      }
      // the accessory cable: another phone, or a laptop when USB debugging is off (so no adb)
      if (Peer && Platform.OS === 'android' && !usbToken) {
        const cableToken = await getText(`${CABLE}/pair`);
        const id = cableToken && (await identify(CABLE, cableToken));
        if (cableToken && id) {
          if (id.kind === 'laptop' && cableToken !== readPrefs().token) writePrefs({ token: cableToken });
          found.push({ id: 'cable', name: id.name, base: CABLE, token: cableToken, kind: id.kind, via: 'usb' });
        }
      }
      const { token, lan } = readPrefs();
      if (!usbToken && token && lan) {
        const id = await identify(lan, token);
        if (id && !found.some((d) => d.kind === 'laptop'))
          found.push({ id: 'laptop-wifi', name: id.name, base: lan, token, kind: 'laptop', via: 'wifi' });
      }
      // paired phones: at the address they announce now, else where they were last time
      const back = await Promise.all(
        savedRef.current.map(async (p) => {
          const f = nearbyRef.current.find((x) => x.id === p.id);
          const base = f ? `http://${f.host}:${f.port}` : p.base;
          const id = await identify(base, p.token);
          return id && { ...p, base, name: id.name };
        }),
      );
      for (const p of back) {
        if (!p) continue;
        const was = savedRef.current.find((x) => x.id === p.id);
        if (was && (was.base !== p.base || was.name !== p.name)) remember(p);
        found.push(phoneDevice(p));
      }
      if (!alive) return;
      setDevices(found);
      const now = currentRef.current;
      const best = [...found].sort((a, b) => (RANK.indexOf(a.id) + 1 || 9) - (RANK.indexOf(b.id) + 1 || 9))[0];
      // stay on the chosen device while it's around (or reconnecting); a cable plugged in takes over
      if (!now || (best?.via === 'usb' && now.id !== best.id && !found.some((d) => d.id === now.id && d.via === 'usb'))) {
        if (best) setCurrent(best);
      } else {
        const fresh = found.find((d) => d.id === now.id);
        if (fresh && (fresh.name !== now.name || fresh.token !== now.token)) setCurrent(fresh);
      }
    };
    probe();
    const timer = setInterval(probe, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [scanning]);

  // phones to offer pairing with: not hidden, not paired already, not already reachable
  const pairable = nearby.filter(
    (f) => !f.hidden && !saved.some((p) => p.id === f.id) && !devices.some((d) => d.base === `http://${f.host}:${f.port}`),
  );

  return { devices, current, setCurrent, nearby: pairable, saved, visible, changeVisible, forget, paired };
}
