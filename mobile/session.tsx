import { useEffect, useRef, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { Easing, FadeIn, FadeOut, LinearTransition, ReduceMotion } from 'react-native-reanimated';
import { Directory, File, Paths } from 'expo-file-system';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { getSaveDir, label, pickSaveDir, saveInto } from './downloads';
import { About } from './about';
import { Sheet, type SheetContent } from './sheet';
import { eta, fileIcon, fmt, haptic, rate, useStyles, type Theme } from './theme';
import { Bar, Cookie, Pop, Press, Ring, ThemeToggle, Toggle } from './ui';
import { myName, Peer, type Found } from './modules/fshare-peer';
import { me } from './identity';
import { openFile } from './open';
import type { SavedPeer } from './prefs';

// something we can send to: the laptop running fshare, or another phone running this app
export type Device = { id: string; name: string; base: string; token: string; kind: 'laptop' | 'phone'; via: 'usb' | 'wifi' };
export type Remote = { id: number; path: string; size: number };
type State = 'queued' | 'preparing' | 'active' | 'paused' | 'saving' | 'done' | 'cancelled' | 'error';
type Job = {
  key: string;
  name: string;
  dir: 'up' | 'down';
  done: number;
  total: number;
  state: State;
  rate?: number;
  file?: File;
  retry?: () => void;
  peer?: string; // the other device's name: where it went, or where it came from
  incoming?: boolean; // pushed to us by another phone: only the sender can pause it
};
type Link = 'connecting' | 'online' | 'offline';

const CLIENT = { 'x-fshare-client': encodeURIComponent(myName) }; // lets the other side show who's connected
const PARALLEL = 3; // a few streams at once keeps the link busy with many small files
const LIVE: State[] = ['queued', 'preparing', 'active', 'paused', 'saving'];
const CANCELLABLE: State[] = ['queued', 'preparing', 'active', 'paused'];
type Control = { cancel: () => void; pause?: () => void };

// Run tasks with at most `n` in flight.
async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

// The part of `src` after `offset`, as its own file, so the native upload can send just that.
function tail(src: File, offset: number, dir: Directory): File {
  dir.create({ intermediates: true, idempotent: true }); // not there yet when the picked file needed no copy (iOS)
  const out = new File(dir, `.tail-${src.name}`);
  if (out.exists) out.delete();
  out.create();
  const r = src.open(),
    w = out.open();
  try {
    r.offset = offset;
    for (let left = src.size - offset; left > 0;) {
      const chunk = r.readBytes(Math.min(left, 4 << 20));
      if (!chunk.length) break;
      w.writeBytes(chunk);
      left -= chunk.length;
    }
  } finally {
    r.close();
    w.close();
  }
  return out;
}

// "a.jpg", "a.jpg and b.jpg", "a.jpg and 3 more"
export function summary(names: string[]) {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} more`;
}

export function Session({
  device,
  devices,
  nearby,
  away,
  saved,
  onForget,
  visible,
  onVisible,
  outbox,
  clearOutbox,
  onPick,
  onPair,
  onWifi,
}: {
  device: Device;
  devices: Device[];
  nearby: Found[];
  away: SavedPeer[];
  saved: SavedPeer[];
  onForget: (p: SavedPeer) => void;
  visible: boolean;
  onVisible: (v: boolean) => void;
  outbox: File[];
  clearOutbox: () => void;
  onPick: (d: Device) => void;
  onPair: (f: Found) => void;
  onWifi: () => void;
}) {
  const server = device;
  const usb = device.via === 'usb';
  const [link, setLink] = useState<Link>('connecting');
  const [laptop, setLaptop] = useState(device.name);
  const [outdated, setOutdated] = useState(false); // laptop runs an fshare without name/resume support
  const [jobs, setJobs] = useState<Job[]>([]);
  const [speed, setSpeed] = useState({ up: 0, down: 0 });
  const [saveDir, setSaveDir] = useState(getSaveDir);
  const [sheet, setSheet] = useState<SheetContent | null>(null);
  const [about, setAbout] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null); // finished transfers chosen in select mode
  const bytes = useRef({ up: 0, down: 0 });
  const controls = useRef(new Map<string, Control>());
  const resumers = useRef(new Map<string, { go: () => void; stop: (e: Error) => void }>()); // paused jobs
  const stopped = useRef(new Set<string>());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // `c` tells the laptop which phone this is, so it hands each file to each phone once
  const urlFor = (d: Device, p: string) => `${d.base}${p}${p.includes('?') ? '&' : '?'}t=${d.token}&c=${me.id}`;
  const url = (p: string) => urlFor(server, p);

  // What the laptop shares downloads by itself: poll its list and fetch anything new.
  const requested = useRef(new Set<string>()); // files we've already started, by laptop + id
  const declined = useRef(false); // no save folder chosen yet; wait until there is one
  const autoGet = useRef((_list: Remote[]) => {});
  autoGet.current = (list) => {
    if (declined.current && !saveDir) return;
    const key = (r: Remote) => `${server.base}|${server.token}|${r.id}|${r.path}|${r.size}`;
    const fresh = list.filter((r) => !requested.current.has(key(r)));
    if (!fresh.length) return;
    fresh.forEach((r) => requested.current.add(key(r)));
    download(fresh).then((ok) => {
      if (ok) return;
      declined.current = true; // they stay on the laptop; picking a folder in Settings starts them
      fresh.forEach((r) => requested.current.delete(key(r)));
    });
  };

  // poll the laptop: brings in new files and tells us if it's still reachable
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      try {
        const r = await fetch(url('/list'), { signal: ctrl.signal, headers: CLIENT });
        if (!r.ok) throw new Error();
        const list = await r.json();
        const name = r.headers.get('x-fshare-name');
        if (alive) {
          autoGet.current(list);
          setLink('online');
          if (name) setLaptop(decodeURIComponent(name));
          setOutdated(!r.headers.get('x-fshare-version'));
        }
      } catch {
        if (alive) setLink('offline');
      }
      clearTimeout(t);
    };
    setLink('connecting');
    setLaptop(device.name);
    setOutdated(false);
    load();
    const t = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [server.base, server.token]);

  // smoothed speed, sampled every 500ms
  useEffect(() => {
    const t = setInterval(() => {
      const b = bytes.current;
      setSpeed((p) => ({ up: p.up * 0.4 + b.up * 2 * 0.6, down: p.down * 0.4 + b.down * 2 * 0.6 }));
      bytes.current = { up: 0, down: 0 };
    }, 500);
    return () => clearInterval(t);
  }, []);

  const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));
  const drop = (key: string) => setJobs((js) => js.filter((j) => j.key !== key));
  const progress = (key: string, dir: 'up' | 'down') => {
    let last = 0,
      mark = 0,
      t = Date.now(),
      r = 0;
    const on = (done: number, total: number) => {
      if (stopped.current.has(key)) return;
      bytes.current[dir] += done - last;
      last = done;
      const now = Date.now();
      if (now - t >= 500) {
        const inst = (done - mark) / ((now - t) / 1000);
        r = r ? r * 0.5 + inst * 0.5 : inst;
        mark = done;
        t = now;
      }
      patch(key, total > 0 ? { done, total, rate: r } : { done, rate: r });
    };
    return Object.assign(on, {
      reset: (from = 0) => {
        last = from;
        mark = from;
        r = 0;
        t = Date.now();
      },
    });
  };

  // a paused transfer awaits this until resumed (or rejects when cancelled)
  const waitForResume = (key: string) => new Promise<void>((go, stop) => resumers.current.set(key, { go, stop }));

  const run = async (key: string, work: () => Promise<void>, cleanup?: () => void) => {
    if (stopped.current.has(key)) return; // cancelled while queued
    patch(key, { state: 'active' });
    try {
      await work();
    } catch (e) {
      if (!stopped.current.has(key)) console.warn(`[fshare] transfer ${key} failed:`, e);
      cleanup?.();
      patch(key, { state: stopped.current.has(key) ? 'cancelled' : 'error', rate: 0 });
    }
    controls.current.delete(key);
    resumers.current.delete(key);
  };

  const pause = (key: string) => controls.current.get(key)?.pause?.();
  const resume = (key: string) => {
    const r = resumers.current.get(key);
    resumers.current.delete(key);
    r?.go();
  };
  const cancel = (key: string) => {
    stopped.current.add(key);
    controls.current.get(key)?.cancel();
    resumers.current.get(key)?.stop(new Error('cancelled'));
    resumers.current.delete(key);
    setJobs((js) => js.map((j) => (j.key === key && CANCELLABLE.includes(j.state) ? { ...j, state: 'cancelled', rate: 0 } : j)));
  };
  const cancelAll = () => jobs.filter((j) => CANCELLABLE.includes(j.state)).forEach((j) => cancel(j.key));
  const pauseAll = () => jobs.filter((j) => j.state === 'active').forEach((j) => pause(j.key));
  const resumeAll = () => jobs.filter((j) => j.state === 'paused').forEach((j) => resume(j.key));
  const clearFinished = () => setJobs((js) => js.filter((j) => LIVE.includes(j.state)));

  // one haptic per batch, not per file
  const finished = (keys: string[]) =>
    setTimeout(() => {
      // after the last state update has rendered
      const mine = jobsRef.current.filter((j) => keys.includes(j.key));
      if (mine.some((j) => j.state === 'error')) haptic.error();
      else if (mine.some((j) => j.state === 'done')) haptic.success();
    }, 100);

  const changeSaveDir = async () => {
    const d = await pickSaveDir();
    if (d) {
      setSaveDir(d);
      declined.current = false;
    }
  };
  const ensureSaveDir = () =>
    new Promise<Directory | null>((resolve) => {
      if (saveDir) return resolve(saveDir);
      setSheet({
        title: 'Choose where to save',
        message:
          'Android only lets apps save inside a folder in Download. Open Download, create a folder like "fshare", then tap "Use this folder".',
        actions: [
          {
            label: 'Choose folder',
            icon: 'folder-outline',
            onPress: async () => {
              const d = await pickSaveDir();
              setSaveDir(d ?? null);
              resolve(d);
            },
          },
        ],
        onCancel: () => resolve(null),
      });
    });

  // false when there's nowhere to save (no folder chosen)
  const download = async (items: Remote[]) => {
    const root = await ensureSaveDir();
    if (!root) return false;
    const batch = items.map((r) => ({ r, key: `d${r.id}-${Date.now()}` }));
    setJobs((js) => [
      ...batch.map(({ r, key }) => ({
        key,
        name: r.path,
        dir: 'down' as const,
        done: 0,
        total: r.size,
        state: 'queued' as const,
        retry: () => {
          drop(key);
          download([r]);
        },
        peer: laptop,
      })),
      ...js,
    ]);
    await pool(batch, PARALLEL, async ({ r, key }) => {
      // download into cache first; only finished files get moved into Downloads
      const tmpDir = new Directory(Paths.cache, 'fshare', key);
      await run(
        key,
        async () => {
          const on = progress(key, 'down');
          tmpDir.create({ intermediates: true, idempotent: true });
          const tmp = new File(tmpDir, r.path.split('/').pop()!);
          const start = () => {
            const task = File.createDownloadTask(url(`/file/${r.id}`), tmp, {
              onProgress: ({ bytesWritten, totalBytes }) => on(bytesWritten, totalBytes),
            });
            controls.current.set(key, {
              cancel: () => task.cancel(),
              pause: () => {
                try {
                  task.pause();
                } catch {}
              },
            });
            return task;
          };
          // a paused download resolves with null; resuming asks the laptop for the rest (HTTP Range)
          let task = start();
          let out = await task.downloadAsync();
          while (!out) {
            if (stopped.current.has(key)) throw new Error('cancelled');
            patch(key, { state: 'paused', rate: 0 });
            await waitForResume(key);
            patch(key, { state: 'active' });
            try {
              out = await task.resumeAsync();
            } catch (e) {
              if (stopped.current.has(key)) throw e;
              // no resume data (e.g. an older fshare without ETags): start this file over instead of failing
              if (tmp.exists) tmp.delete();
              on.reset();
              patch(key, { done: 0 });
              task = start();
              out = await task.downloadAsync();
            }
          }
          if (stopped.current.has(key)) throw new Error('cancelled');
          patch(key, { state: 'saving', done: r.size });
          const saved = await saveInto(root, tmp, r.path);
          tmpDir.delete();
          patch(key, { state: 'done', file: saved });
        },
        () => {
          try {
            tmpDir.delete();
          } catch {}
        },
      );
    });
    finished(batch.map((b) => b.key));
    return true;
  };

  // `to` defaults to the device on screen; the share-sheet confirm can pick another one
  const upload = async (files: File[], to: Device = server) => {
    const url = (p: string) => urlFor(to, p);
    const toName = to.id === server.id ? laptop : to.name;
    const batch = files.map((f, i) => ({ f, key: `u${Date.now()}-${i}` }));
    setJobs((js) => [
      ...batch.map(({ f, key }) => ({
        key,
        name: f.name,
        dir: 'up' as const,
        done: 0,
        total: f.size,
        state: 'queued' as const,
        peer: toName,
        retry: () => {
          drop(key);
          upload([f], to);
        },
      })),
      ...js,
    ]);
    await pool(batch, PARALLEL, async ({ f, key }) => {
      const tmpDir = new Directory(Paths.cache, 'fshare-up', key);
      await run(
        key,
        async () => {
          let src = f;
          controls.current.set(key, { cancel: () => {} }); // the copy can't be interrupted; checked right after
          // Android hands us a content:// URI served through the media provider's FUSE layer; the
          // upload reads it 8 KB at a time (~2-4 MB/s on a Galaxy S23). copy() reads in big chunks,
          // and the copy also gets the real file name instead of "msf:1000113138".
          if (!f.uri.startsWith('file:')) {
            patch(key, { state: 'preparing' });
            tmpDir.create({ intermediates: true, idempotent: true });
            await f.copy(tmpDir);
            src = tmpDir.list()[0] as File;
            if (stopped.current.has(key)) throw new Error('cancelled');
            patch(key, { state: 'active', name: src.name });
          }
          const on = progress(key, 'up');
          const size = src.size;
          const forget = () => fetch(url(`/upload?id=${key}`), { method: 'DELETE' }).catch(() => {}); // laptop forgets the part
          let offset = 0;
          for (;;) {
            const ctrl = new AbortController();
            let pausing = false;
            controls.current.set(key, {
              cancel: () => {
                ctrl.abort();
                forget();
              },
              pause: () => {
                pausing = true;
                ctrl.abort();
              },
            });
            try {
              // resuming: upload only the bytes the laptop doesn't have yet
              const body = offset ? tail(src, offset, tmpDir) : src;
              const r = await body.upload(url(`/upload?name=${encodeURIComponent(src.name)}&id=${key}&offset=${offset}&size=${size}`), {
                httpMethod: 'PUT',
                headers: CLIENT,
                signal: ctrl.signal,
                onProgress: ({ bytesSent }) => on(offset + bytesSent, size),
              });
              if (r.status === 409) {
                offset = JSON.parse(r.body).received;
                on.reset(offset);
                continue;
              } // laptop has less than we thought
              if (r.status !== 200) throw new Error(r.body);
              break;
            } catch (e) {
              if (!pausing || stopped.current.has(key)) throw e;
              patch(key, { state: 'paused', rate: 0 });
              await waitForResume(key);
              patch(key, { state: 'active' });
              // ask the laptop how much it kept; older fshare builds keep nothing, so that restarts at 0
              offset = await fetch(url(`/upload?id=${key}`))
                .then((r) => r.json())
                .then((j) => j.received ?? 0)
                .catch(() => 0);
              on.reset(offset);
              patch(key, { done: offset });
            }
          }
          patch(key, { state: 'done', done: f.size });
        },
        () => {
          fetch(url(`/upload?id=${key}`), { method: 'DELETE' }).catch(() => {});
        },
      ); // failed: laptop drops the partial
      try {
        tmpDir.delete();
      } catch {}
    });
    finished(batch.map((b) => b.key));
  };

  const pickAndSend = async () => {
    const res = await File.pickFileAsync({ multipleFiles: true });
    if (!res.canceled) upload(res.result);
  };

  // Files shared into fshare from another app (Gallery › Share): confirm where they go first.
  useEffect(() => {
    if (link !== 'online' || !outbox.length) return;
    const files = outbox;
    const names = files.map((f) => {
      try {
        return decodeURIComponent(f.name);
      } catch {
        return 'file';
      }
    });
    const size = files.reduce((n, f) => {
      try {
        return n + (f.size ?? 0);
      } catch {
        return n;
      }
    }, 0);
    const send = (d: Device) => () => {
      haptic.tap();
      clearOutbox();
      upload(files, d);
    };
    haptic.select();
    setSheet({
      title: files.length === 1 ? 'Send this file?' : `Send ${files.length} files?`,
      message: `${summary(names)}${size ? ` · ${fmt(size)}` : ''}`,
      actions: [
        {
          label: `Send to ${laptop}`,
          detail: `${device.kind === 'laptop' ? 'Laptop' : 'Phone'} · ${usb ? 'USB cable' : 'Wi-Fi'}`,
          icon: 'arrow-up',
          onPress: send(device),
        },
        ...devices
          .filter((d) => d.id !== device.id)
          .map((d) => ({
            label: `Send to ${d.name}`,
            detail: `${d.kind === 'laptop' ? 'Laptop' : 'Phone'} · ${d.via === 'usb' ? 'USB cable' : 'Wi-Fi'}`,
            icon: d.kind === 'laptop' ? ('laptop-outline' as const) : ('phone-portrait-outline' as const),
            onPress: send(d),
          })),
      ],
      onCancel: clearOutbox,
    });
  }, [link, outbox]);

  // Another phone pushing files to us. Its upload streams into the native server; we mirror the
  // progress as a job, then move the finished file into the save folder like any download.
  const incoming = useRef(new Map<string, string>()); // upload id -> job key
  const lastDone = useRef(new Map<string, number>());
  const onPeer = useRef({
    progress: (_e: { id: string; name: string; from: string; done: number; total: number }) => {},
    received: (_e: { id: string; name: string; uri: string; size: number }) => {},
    stopped: (_e: { id: string; reason: 'paused' | 'cancelled' }) => {},
  });
  onPeer.current = {
    progress: ({ id, name, from, done, total }) => {
      let key = incoming.current.get(id);
      if (!key || !jobsRef.current.some((j) => j.key === key && LIVE.includes(j.state))) {
        key = `in-${id}-${Date.now()}`;
        incoming.current.set(id, key);
        lastDone.current.set(id, done);
        const k = key;
        controls.current.set(k, { cancel: () => Peer?.cancel(id) });
        setJobs((js) => [{ key: k, name, dir: 'down', done, total, state: 'active', peer: from, incoming: true }, ...js]);
        return;
      }
      const prev = lastDone.current.get(id) ?? done;
      bytes.current.down += Math.max(0, done - prev);
      lastDone.current.set(id, done);
      patch(key, { done, total, state: 'active', rate: (done - prev) * 4 }); // events come every ~250 ms
    },
    stopped: ({ id, reason }) => {
      const key = incoming.current.get(id);
      if (key) patch(key, { state: reason === 'paused' ? 'paused' : 'cancelled', rate: 0 });
      if (key && reason === 'cancelled') {
        controls.current.delete(key);
        finished([key]);
      }
    },
    received: async ({ id, name, uri, size }) => {
      const key = incoming.current.get(id);
      if (!key) return;
      patch(key, { state: 'saving', done: size, rate: 0 });
      controls.current.delete(key);
      const root = await ensureSaveDir();
      try {
        if (!root) throw new Error('no save folder');
        const saved = await saveInto(root, new File(uri), name);
        patch(key, { state: 'done', file: saved });
      } catch (e) {
        console.warn('[fshare] saving a received file failed:', e);
        patch(key, { state: 'error' });
      }
      incoming.current.delete(id);
      finished([key]);
    },
  };
  useEffect(() => {
    if (!Peer) return;
    const subs = [
      Peer.addListener('progress', (e) => onPeer.current.progress(e)),
      Peer.addListener('stopped', (e) => onPeer.current.stopped(e)),
      Peer.addListener('received', (e) => onPeer.current.received(e)),
    ];
    return () => subs.forEach((x) => x.remove());
  }, []);

  const [st, t] = useStyles(styles);
  const insets = useSafeAreaInsets();
  const live = jobs.filter((j) => LIVE.includes(j.state));
  const completed = jobs.filter((j) => !LIVE.includes(j.state)); // in-flight files live in the card instead
  const liveTotal = live.reduce((a, j) => a + j.total, 0);
  const liveDone = live.reduce((a, j) => a + j.done, 0);
  const totalSpeed = speed.up + speed.down;
  const online = link === 'online';
  const allPaused = live.length > 0 && live.every((j) => j.state === 'paused');

  // speed and time-left are noise for the first moments; wait until the rate has settled
  const since = useRef(0);
  if (!live.length || allPaused) since.current = 0;
  else if (!since.current) since.current = Date.now();
  const settled = !allPaused && totalSpeed > 2e5 && Date.now() - since.current > 1500;
  const moving = live.some((j) => j.state !== 'queued' && j.state !== 'preparing');
  const dirs = new Set(live.map((j) => j.dir));
  const verb = dirs.size > 1 ? 'Transferring' : dirs.has('up') ? 'Sending' : 'Receiving';
  const panelTitle = allPaused ? 'Paused' : moving ? `${verb} ${live.length} ${live.length === 1 ? 'file' : 'files'}` : 'Preparing…';

  const wifi = () => {
    if (!live.length) return onWifi();
    haptic.reject();
    setSheet({
      title: 'Transfers in progress',
      message: 'Setting up Wi-Fi cancels the files that are still transferring.',
      actions: [
        {
          label: 'Cancel transfers',
          icon: 'close',
          destructive: true,
          onPress: () => {
            cancelAll();
            onWifi();
          },
        },
      ],
    });
  };

  // every device we can reach right now, plus phones nearby we could pair with
  const others = devices.filter((d) => d.id !== device.id);
  const picker = () => {
    haptic.tap();
    const close = (fn: () => void) => {
      setSheet(null);
      setTimeout(fn, 260);
    }; // after the sheet slides away
    setSheet({
      title: 'Devices',
      extra: (
        <DeviceList
          current={{ ...device, name: laptop }}
          others={others}
          nearby={nearby}
          away={away}
          saved={saved}
          onPick={(d) => close(() => onPick(d))}
          onPair={(f) => close(() => onPair(f))}
          onForget={(p) => close(() => onForget(p))}
        />
      ),
      footer: !!Peer && <VisibilityRow visible={visible} onChange={onVisible} bg={t.surface2} />,
      actions: [],
    });
  };

  const menu = () =>
    setSheet({
      title: 'Settings',
      subtitle: <ConnectionLine laptop={laptop} usb={usb} kind={device.kind} />,
      extra: <ThemeToggle />,
      actions: [
        ...(Platform.OS === 'android'
          ? [
              {
                label: 'Save folder',
                detail: saveDir ? label(saveDir) : 'Not set',
                icon: 'folder-outline' as const,
                onPress: changeSaveDir,
              },
            ]
          : []),
        {
          label: device.kind === 'laptop' && !usb ? 'Scan again' : 'Connect over Wi-Fi',
          detail: 'Press q in fshare, then scan',
          icon: 'qr-code-outline',
          onPress: wifi,
        },
        { label: 'About', detail: 'Version and connection', icon: 'information-circle-outline', onPress: () => setAbout(true) },
      ],
    });

  // select mode for finished transfers: long-press, then delete received files or clear them
  const selecting = picked !== null;
  const allPicked = selecting && completed.length > 0 && completed.every((j) => picked.has(j.key));
  const startPick = (key?: string) => {
    haptic.select();
    setPicked(new Set(key ? [key] : []));
  };
  const togglePick = (key: string) => {
    haptic.select();
    setPicked((cur) => {
      const n = new Set(cur);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });
  };
  const pickAll = () => {
    haptic.select();
    setPicked(allPicked ? new Set() : new Set(completed.map((j) => j.key)));
  };
  const clearPicked = () => {
    const keys = picked ?? new Set();
    haptic.select();
    setJobs((js) => js.filter((j) => !keys.has(j.key)));
    setPicked(null);
  };
  const deletePicked = () => {
    const chosen = jobs.filter((j) => picked?.has(j.key));
    const onPhone = chosen.filter((j) => j.dir === 'down' && j.file);
    haptic.reject();
    setSheet({
      title: onPhone.length === 1 ? 'Delete this file?' : `Delete ${onPhone.length} files?`,
      message: `${summary(onPhone.map((j) => j.name.split('/').pop()!))}. They're removed from this phone; files on other devices stay.`,
      actions: [
        {
          label: 'Delete',
          icon: 'trash-outline',
          destructive: true,
          onPress: () => {
            for (const j of onPhone) {
              try {
                j.file!.delete();
              } catch {}
            }
            setJobs((js) => js.filter((j) => !picked?.has(j.key)));
            setPicked(null);
            haptic.success();
          },
        },
      ],
    });
  };
  const pickedJobs = completed.filter((j) => picked?.has(j.key));
  const canDelete = pickedJobs.some((j) => j.dir === 'down' && j.file);
  useEffect(() => {
    if (selecting && !completed.length) setPicked(null);
  }, [completed.length]);

  const open = async (job: Job) => {
    haptic.tap();
    if (!job.file || !(await openFile(job.file))) {
      haptic.error();
      setSheet({ title: "Couldn't open this file", message: 'No app on this phone can open it, or it was moved or deleted.', actions: [] });
    }
  };

  // one quiet chip for the connection: grey normally, red only while reconnecting
  const chip =
    link === 'online'
      ? { icon: usb ? ('flash' as const) : ('wifi' as const), label: usb ? 'USB cable' : 'Wi-Fi', bg: t.surface2, fg: t.dim, spin: false }
      : link === 'offline'
        ? { icon: 'sync' as const, label: 'Reconnecting…', bg: t.redSoft, fg: t.red, spin: true }
        : { icon: 'sync' as const, label: 'Connecting…', bg: t.surface2, fg: t.dim, spin: true };

  return (
    <SafeAreaView style={st.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={st.content} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        {/* the device area switches devices; Settings sits beside it, so each stays its own button */}
        <View style={st.device}>
          <Press
            grow
            style={st.deviceTap}
            highlight={t.surface2}
            onPress={picker}
            accessibilityRole="button"
            accessibilityLabel={`${laptop}, ${online ? `connected over ${chip.label}` : chip.label}`}
            accessibilityHint="Switch device"
          >
            <Pop id={device.kind}>
              <Cookie size={58} color={t.accentSoft}>
                <Ionicons name={device.kind === 'laptop' ? 'laptop-outline' : 'phone-portrait-outline'} size={25} color={t.onAccentSoft} />
              </Cookie>
            </Pop>
            <View style={{ flex: 1, gap: 5 }}>
              <Pop id={laptop} fade>
                <Text style={st.deviceName} numberOfLines={1}>
                  {laptop}
                </Text>
              </Pop>
              <Pop id={chip.label} fade>
                <Animated.View
                  style={[st.chip, { backgroundColor: chip.bg, transitionProperty: 'backgroundColor', transitionDuration: 200 }]}
                  accessible
                  accessibilityLabel={online ? `Connected over ${chip.label}` : chip.label}
                >
                  <Animated.View
                    style={
                      chip.spin && {
                        animationName: { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } },
                        animationDuration: '1.4s',
                        animationIterationCount: 'infinite',
                        animationTimingFunction: 'linear',
                      }
                    }
                  >
                    <Ionicons name={chip.icon} size={12} color={chip.fg} />
                  </Animated.View>
                  <Text style={[st.chipText, { color: chip.fg }]} numberOfLines={1}>
                    {chip.label}
                  </Text>
                </Animated.View>
              </Pop>
              {outdated && online && device.kind === 'laptop' && (
                <Text style={[st.meta, { color: t.amber, fontSize: 12 }]}>Restart fshare on your laptop to update it</Text>
              )}
            </View>
          </Press>
          {/* one capsule: devices, then settings */}
          <View style={st.actions}>
            <Press style={st.action} onPress={picker} hitSlop={4} accessibilityRole="button" accessibilityLabel="Switch device">
              <MaterialCommunityIcons name="devices" size={19} color={t.text} />
            </Press>
            <View style={st.actionSep} />
            <Press style={st.action} onPress={menu} hitSlop={4} accessibilityRole="button" accessibilityLabel="Settings">
              <Ionicons name="settings-outline" size={18} color={t.text} />
            </Press>
          </View>
        </View>

        {live.length > 0 && (
          <Animated.View style={st.panel} entering={ENTER} exiting={EXIT} layout={LAYOUT}>
            <View style={st.between}>
              <Pop id={panelTitle} fade>
                <Text style={st.panelTitle}>{panelTitle}</Text>
              </Pop>
              <Text style={[st.meta, st.num]}>{settled ? eta((liveTotal - liveDone) / totalSpeed) : ''}</Text>
            </View>
            <View style={st.speedRow}>
              <Text style={[st.speed, !settled && { color: t.faint }]}>{settled ? (totalSpeed / 1e6).toFixed(1) : '0.0'}</Text>
              <Text style={st.unit}>MB/s</Text>
            </View>
            <Bar f={liveTotal ? liveDone / liveTotal : 0} color={allPaused ? t.faint : t.accent} track={t.surface3} />
            <View style={st.liveList}>
              {live.slice(0, MAX_LIVE).map((job) => (
                <LiveRow
                  key={job.key}
                  job={job}
                  onCancel={() => {
                    haptic.reject();
                    cancel(job.key);
                  }}
                  onPause={() => {
                    haptic.toggle(false);
                    pause(job.key);
                  }}
                  onResume={() => {
                    haptic.toggle(true);
                    resume(job.key);
                  }}
                />
              ))}
              {live.length > MAX_LIVE && (
                <Animated.Text style={[st.meta, { paddingLeft: 42 }]} layout={LAYOUT}>
                  +{live.length - MAX_LIVE} more
                </Animated.Text>
              )}
            </View>
            <View style={[st.between, st.panelFoot]}>
              <Text style={[st.meta, st.num, { flex: 1 }]} numberOfLines={1}>
                {fmt(liveDone)} of {fmt(liveTotal)}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {(allPaused || live.some((j) => j.state === 'active')) && (
                  <Press
                    style={st.pill}
                    onPress={() => {
                      haptic.toggle(allPaused);
                      if (allPaused) resumeAll();
                      else pauseAll();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={allPaused ? 'Resume all' : 'Pause all'}
                  >
                    <Ionicons name={allPaused ? 'play' : 'pause'} size={13} color={t.text} />
                    <Text style={st.pillText}>{allPaused ? 'Resume' : 'Pause'}</Text>
                  </Press>
                )}
                <Press
                  style={[st.pill, { backgroundColor: t.redSoft }]}
                  onPress={() => {
                    haptic.reject();
                    cancelAll();
                  }}
                  accessibilityRole="button"
                >
                  <Text style={[st.pillText, { color: t.red }]}>Cancel</Text>
                </Press>
              </View>
            </View>
          </Animated.View>
        )}

        {!jobs.length && (
          <Animated.View style={st.empty} entering={ENTER} exiting={EXIT}>
            <Cookie size={76} color={t.surface2}>
              <Ionicons name="swap-vertical" size={26} color={t.dim} />
            </Cookie>
            <Text style={st.emptyTitle}>Nothing here yet</Text>
            <Text style={[st.meta, { textAlign: 'center', lineHeight: 19 }]}>
              {device.kind === 'laptop'
                ? 'Drop files into fshare on your laptop and they download here by themselves. Tap Send files to go the other way.'
                : `Send files to ${laptop}. Anything they send you shows up here.`}
            </Text>
          </Animated.View>
        )}

        {completed.length > 0 && (
          <Animated.View entering={ENTER} exiting={EXIT} layout={LAYOUT}>
            <View style={st.sectionHead}>
              <Text style={st.sectionTitle}>Transfers</Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                {selecting ? (
                  <Press style={st.textBtn} onPress={pickAll} hitSlop={8} accessibilityRole="button">
                    <Text style={st.textBtnLabel}>{allPicked ? 'Deselect all' : 'Select all'}</Text>
                  </Press>
                ) : (
                  <>
                    <Press style={st.textBtn} onPress={() => startPick()} hitSlop={8} accessibilityRole="button">
                      <Text style={st.textBtnLabel}>Select</Text>
                    </Press>
                    <Press
                      style={st.textBtn}
                      onPress={() => {
                        haptic.select();
                        clearFinished();
                      }}
                      hitSlop={8}
                      accessibilityRole="button"
                    >
                      <Text style={st.textBtnLabel}>Clear</Text>
                    </Press>
                  </>
                )}
              </View>
            </View>
            <View style={st.group}>
              {completed.map((job, i) => (
                <Animated.View key={job.key} entering={ENTER} exiting={EXIT} layout={LAYOUT}>
                  <JobRow
                    job={job}
                    style={st.cell}
                    first={i === 0}
                    selecting={selecting}
                    selected={!!picked?.has(job.key)}
                    onPress={() => (selecting ? togglePick(job.key) : job.state === 'done' && job.file ? open(job) : job.retry?.())}
                    onLongPress={() => (selecting ? togglePick(job.key) : startPick(job.key))}
                  />
                </Animated.View>
              ))}
            </View>
          </Animated.View>
        )}
      </ScrollView>
      {/* Send stays put at the bottom; content scrolls under a short fade */}
      <View style={[st.dock, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <View style={st.fade} pointerEvents="none" />
        {selecting ? (
          <Animated.View key="select" entering={ENTER} style={st.actionBar}>
            <Press
              style={st.barClose}
              onPress={() => {
                haptic.select();
                setPicked(null);
              }}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Done selecting"
            >
              <Ionicons name="close" size={18} color={t.text} />
            </Press>
            <Text style={st.barCount} numberOfLines={1}>
              {picked!.size ? `${picked!.size} selected` : 'Select files'}
            </Text>
            <Press
              style={st.barBtn}
              disabled={!picked!.size}
              onPress={clearPicked}
              accessibilityRole="button"
              accessibilityLabel="Clear from list"
            >
              <Ionicons name="list-outline" size={16} color={t.text} />
              <Text style={st.barBtnText}>Clear</Text>
            </Press>
            <Press
              style={[st.barBtn, { backgroundColor: t.redSoft }]}
              disabled={!canDelete}
              onPress={deletePicked}
              accessibilityRole="button"
              accessibilityLabel="Delete from phone"
            >
              <Ionicons name="trash-outline" size={16} color={t.red} />
              <Text style={[st.barBtnText, { color: t.red }]}>Delete</Text>
            </Press>
          </Animated.View>
        ) : (
          <Animated.View key="send" entering={ENTER}>
            <Press
              style={st.send}
              disabled={!online}
              onPress={() => {
                haptic.tap();
                pickAndSend();
              }}
              accessibilityRole="button"
              accessibilityLabel="Send files"
            >
              <Ionicons name="arrow-up" size={20} color={t.onAccent} />
              <Text style={st.sendText}>Send files</Text>
            </Press>
          </Animated.View>
        )}
      </View>
      <Sheet content={sheet} onClose={() => setSheet(null)} />
      <About
        open={about}
        onClose={() => setAbout(false)}
        laptop={laptop}
        usb={usb}
        host={server.base}
        outdated={outdated && device.kind === 'laptop'}
        kind={device.kind}
      />
    </SafeAreaView>
  );
}

// short, eased, and reduced-motion aware: rows and panels fade in, the rest of the list glides
const MAX_LIVE = 4; // more than this collapses into "+N more"
const ENTER = FadeIn.duration(220)
  .easing(Easing.bezier(0.23, 1, 0.32, 1))
  .reduceMotion(ReduceMotion.System);
const EXIT = FadeOut.duration(160).reduceMotion(ReduceMotion.System);
const LAYOUT = LinearTransition.duration(240)
  .easing(Easing.bezier(0.77, 0, 0.175, 1))
  .reduceMotion(ReduceMotion.System);

// "⚡ USB cable · Ashish's MacBook Air" under the settings title: icon + medium label, laptop in dim.
function ConnectionLine({ laptop, usb, kind }: { laptop: string; usb: boolean; kind: Device['kind'] }) {
  const [st, t] = useStyles(styles);
  return (
    <View style={st.connLine} accessible accessibilityLabel={`Connected to ${laptop} over ${usb ? 'USB cable' : 'Wi-Fi'}`}>
      <Ionicons name={kind === 'phone' ? 'phone-portrait-outline' : usb ? 'flash' : 'wifi'} size={14} color={t.text} />
      <Text style={st.connVia}>{usb ? 'USB cable' : 'Wi-Fi'}</Text>
      <Text style={st.connDot}>·</Text>
      <Text style={[st.meta, { flexShrink: 1, fontSize: 14 }]} numberOfLines={1}>
        {laptop}
      </Text>
    </View>
  );
}

// round tick for select mode: filled when picked, a dash when part of a folder is
function Check({ state }: { state: 'all' | 'some' | 'none' }) {
  const [st, t] = useStyles(styles);
  const on = state !== 'none';
  return (
    <Animated.View
      style={[
        st.check,
        {
          backgroundColor: on ? t.accent : 'transparent',
          borderColor: on ? t.accent : t.faint,
          transitionProperty: ['backgroundColor', 'borderColor'],
          transitionDuration: 150,
        },
      ]}
    >
      {on && (
        <Pop id={state}>
          <Ionicons name={state === 'all' ? 'checkmark' : 'remove'} size={16} color={t.onAccent} />
        </Pop>
      )}
    </Animated.View>
  );
}

// "Devices" sheet: where you are now, what else is connected, and phones you could pair with
export function DeviceList({
  current,
  others,
  nearby,
  away,
  saved,
  onPick,
  onPair,
  onForget,
}: {
  current: Device;
  others: Device[];
  nearby: Found[];
  away: SavedPeer[];
  saved: SavedPeer[];
  onPick: (d: Device) => void;
  onPair: (f: Found) => void;
  onForget: (p: SavedPeer) => void;
}) {
  const [st, t] = useStyles(styles);
  const icon = (kind: Device['kind']) => (kind === 'laptop' ? ('laptop-outline' as const) : ('phone-portrait-outline' as const));
  const via = (d: Device) => `${d.kind === 'laptop' ? 'Laptop' : 'Phone'} · ${d.via === 'usb' ? 'USB cable' : 'Wi-Fi'}`;
  const row = (
    key: string,
    name: string,
    detail: string,
    ic: keyof typeof Ionicons.glyphMap,
    active: boolean,
    onPress?: () => void,
    action?: string,
    onLongPress?: () => void,
  ) => (
    <Press
      key={key}
      style={st.devRow}
      highlight={onPress ? t.surface3 : undefined}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={`${name}, ${detail}${active ? ', connected' : ''}`}
      accessibilityHint={onLongPress ? 'Long press to forget this phone' : undefined}
    >
      <View style={[st.devIcon, { backgroundColor: active ? t.accentSoft : t.surface3 }]}>
        <Ionicons name={ic} size={19} color={active ? t.onAccentSoft : t.text} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={st.meta} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      {active ? (
        <View style={st.devNow}>
          <Ionicons name="checkmark" size={14} color={t.onAccent} />
        </View>
      ) : action ? (
        <View style={st.devAction}>
          <Text style={st.devActionText}>{action}</Text>
        </View>
      ) : (
        <Ionicons name="chevron-forward" size={16} color={t.faint} />
      )}
    </Press>
  );
  // long-press a paired phone to forget it
  const pairedTo = (d: Device) => saved.find((p) => `phone-${p.id}` === d.id);
  const forgets = (d: Device) => {
    const p = pairedTo(d);
    return p && (() => onForget(p));
  };
  return (
    <View style={{ gap: 18 }}>
      <View style={st.devGroup}>
        {row(current.id, current.name, via(current), icon(current.kind), true, undefined, undefined, forgets(current))}
        {others.map((d) => (
          <View key={d.id}>
            <View style={st.devSep} />
            {row(d.id, d.name, via(d), icon(d.kind), false, () => onPick(d), 'Switch', forgets(d))}
          </View>
        ))}
      </View>
      {away.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={st.devLabel}>Your phones</Text>
          <SavedList peers={away} onForget={onForget} bg={t.surface2} />
        </View>
      )}
      {nearby.length > 0 && (
        <View style={{ gap: 8 }}>
          <Text style={st.devLabel}>Nearby phones</Text>
          <View style={st.devGroup}>
            {nearby.map((f, i) => (
              <View key={f.name}>
                {i > 0 && <View style={st.devSep} />}
                {row(f.name, f.name, 'On this Wi-Fi', 'phone-portrait-outline', false, () => onPair(f), 'Connect')}
              </View>
            ))}
          </View>
        </View>
      )}
      {!others.length && !nearby.length && !away.length && (
        <Text style={[st.meta, { paddingHorizontal: 4, lineHeight: 19 }]}>
          To add a device, plug in a USB cable, or open fshare on another phone on the same Wi-Fi.
        </Text>
      )}
    </View>
  );
}

// Phones paired before that aren't reachable right now. They reconnect by themselves when back.
export function SavedList({ peers, onForget, bg }: { peers: SavedPeer[]; onForget: (p: SavedPeer) => void; bg?: string }) {
  const [st, t] = useStyles(styles);
  return (
    <View style={[st.devGroup, bg ? { backgroundColor: bg } : { backgroundColor: t.surface }]}>
      {peers.map((p, i) => (
        <View key={p.id}>
          {i > 0 && <View style={st.devSep} />}
          <View style={[st.devRow, { backgroundColor: 'transparent' }]} accessible accessibilityLabel={`${p.name}, not nearby`}>
            <View style={[st.devIcon, { backgroundColor: bg ? t.surface3 : t.surface2 }]}>
              <Ionicons name="phone-portrait-outline" size={19} color={t.dim} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[st.name, { color: t.dim }]} numberOfLines={1}>
                {p.name}
              </Text>
              <Text style={st.meta} numberOfLines={1}>
                Not nearby
              </Text>
            </View>
            <Press
              style={[st.devAction, { backgroundColor: bg ? t.surface3 : t.surface2 }]}
              onPress={() => onForget(p)}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={`Forget ${p.name}`}
            >
              <Text style={st.devActionText}>Forget</Text>
            </Press>
          </View>
        </View>
      ))}
    </View>
  );
}

// "Visible to nearby phones" switch. Off: other phones don't list this one and can't ask to pair;
// phones already paired still connect.
export function VisibilityRow({ visible, onChange, bg }: { visible: boolean; onChange: (v: boolean) => void; bg?: string }) {
  const [st, t] = useStyles(styles);
  const [on, setOn] = useState(visible); // the sheet renders this once, so it keeps its own copy
  return (
    <Press
      style={[st.devGroup, st.devRow, { backgroundColor: bg ?? t.surface }]}
      highlight={bg ? t.surface3 : t.surface2}
      onPress={() => {
        haptic.toggle(!on);
        setOn(!on);
        onChange(!on);
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel="Visible to nearby phones"
    >
      <View style={[st.devIcon, { backgroundColor: on ? t.accentSoft : bg ? t.surface3 : t.surface2 }]}>
        <Ionicons name={on ? 'eye-outline' : 'eye-off-outline'} size={19} color={on ? t.onAccentSoft : t.dim} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={st.name} numberOfLines={1}>
          Visible to nearby phones
        </Text>
        <Text style={st.meta} numberOfLines={1}>
          {on ? `Shown as ${myName}` : 'Paired phones only'}
        </Text>
      </View>
      <Toggle on={on} />
    </Press>
  );
}

function IconButton({
  icon,
  tone = 'plain',
  onPress,
  disabled,
  label,
  small,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  tone?: 'plain' | 'accent' | 'filled';
  onPress: () => void;
  disabled?: boolean;
  label: string;
  small?: boolean;
}) {
  const [st, t] = useStyles(styles);
  const [bg, fg] = tone === 'filled' ? [t.accent, t.onAccent] : tone === 'accent' ? [t.accentSoft, t.onAccentSoft] : [t.surface3, t.text];
  return (
    <Press
      style={[st.iconBtn, small && st.iconBtnSmall, { backgroundColor: bg }]}
      onPress={onPress}
      disabled={disabled}
      hitSlop={small ? 10 : 8}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      <Ionicons name={icon} size={small ? 14 : 16} color={fg} />
    </Press>
  );
}

// One file inside the transferring card: small ring, name, progress, and its own controls.
function LiveRow({ job, onCancel, onPause, onResume }: { job: Job; onCancel: () => void; onPause: () => void; onResume: () => void }) {
  const [st, t] = useStyles(styles);
  const f = job.total ? job.done / job.total : 0;
  const pct = `${Math.floor(f * 100)}%`;
  const status =
    job.state === 'active'
      ? job.rate
        ? `${pct} · ${rate(job.rate)}`
        : pct
      : job.state === 'paused'
        ? `Paused · ${pct}`
        : job.state === 'saving'
          ? 'Saving…'
          : job.state === 'preparing'
            ? 'Preparing…'
            : 'Waiting';
  return (
    <Animated.View
      style={st.liveRow}
      entering={ENTER}
      exiting={EXIT}
      layout={LAYOUT}
      accessible
      accessibilityLabel={`${job.name.split('/').pop()}, ${status}`}
    >
      <View style={st.mini}>
        <Ring
          f={job.state === 'saving' ? 1 : f}
          size={32}
          stroke={2.5}
          color={job.state === 'paused' ? t.faint : t.accent}
          track={t.surface3}
        />
        <Ionicons
          name={job.state === 'paused' ? 'pause' : job.dir === 'up' ? 'arrow-up' : 'arrow-down'}
          size={14}
          color={job.state === 'paused' ? t.dim : t.text}
        />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={st.liveName} numberOfLines={1}>
          {job.name.split('/').pop()}
        </Text>
        <Text style={[st.meta, st.num, { fontSize: 12 }]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      {job.state === 'active' && job.done > 0 && !job.incoming && (
        <IconButton small icon="pause" onPress={onPause} label={`Pause ${job.name}`} />
      )}
      {job.state === 'paused' && !job.incoming && (
        <IconButton small icon="play" tone="filled" onPress={onResume} label={`Resume ${job.name}`} />
      )}
      {CANCELLABLE.includes(job.state) && <IconButton small icon="close" onPress={onCancel} label={`Cancel ${job.name}`} />}
    </Animated.View>
  );
}

// A finished transfer. Received files open on tap; failed ones retry; long-press selects.
function JobRow({
  job,
  style,
  first,
  selecting,
  selected,
  onPress,
  onLongPress,
}: {
  job: Job;
  style: StyleProp<ViewStyle>;
  first: boolean;
  selecting: boolean;
  selected: boolean;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const [st, t] = useStyles(styles);
  const name = job.name.split('/').pop()!;
  const failed = job.state === 'error' || job.state === 'cancelled';
  const opens = job.state === 'done' && job.dir === 'down' && !!job.file;
  const status = failed
    ? `${job.state === 'error' ? 'Failed' : 'Cancelled'}${job.retry ? ' · Tap to retry' : ''}`
    : job.dir === 'up'
      ? `Sent to ${job.peer ?? 'laptop'} · ${fmt(job.total)}`
      : `${job.peer ? `From ${job.peer}` : Platform.OS === 'ios' ? 'Saved to Files' : 'Saved to Downloads'} · ${fmt(job.total)}`;
  const thumb = failed
    ? {
        bg: job.state === 'error' ? t.redSoft : t.surface2,
        fg: job.state === 'error' ? t.red : t.dim,
        icon: job.retry ? ('refresh' as const) : ('close' as const),
      }
    : job.dir === 'up'
      ? { bg: t.surface2, fg: t.dim, icon: 'arrow-up' as const }
      : { bg: t.accentSoft, fg: t.onAccentSoft, icon: fileIcon(name) };
  return (
    <Press
      style={[style, selected && { backgroundColor: t.surface2 }]}
      highlight={t.surface2}
      onPress={selecting || opens || (failed && job.retry) ? onPress : undefined}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityState={selecting ? { selected } : undefined}
      accessibilityLabel={`${name}, ${status}`}
      accessibilityHint={selecting ? undefined : opens ? 'Opens the file. Long press to select' : 'Long press to select'}
    >
      {!first && <View style={st.sep} />}
      <View style={[st.thumb, { backgroundColor: thumb.bg }]}>
        <Ionicons name={thumb.icon} size={19} color={thumb.fg} />
      </View>
      <View style={st.cellText}>
        <Text style={st.name} numberOfLines={1}>
          {name}
        </Text>
        <Text style={[st.meta, st.num, job.state === 'error' && { color: t.red }]} numberOfLines={1}>
          {status}
        </Text>
      </View>
      {selecting ? <Check state={selected ? 'all' : 'none'} /> : opens && <Ionicons name="open-outline" size={17} color={t.faint} />}
    </Press>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120, gap: 12 },
    dock: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 4, backgroundColor: t.bg },
    fade: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: -28,
      height: 28,
      experimental_backgroundImage: `linear-gradient(to bottom, ${t.bg}00, ${t.bg})`,
    },
    between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
    meta: { color: t.dim, fontSize: 13 },
    num: { fontVariant: ['tabular-nums'] },

    device: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 14,
      borderRadius: 24,
      borderCurve: 'continuous',
      backgroundColor: t.surface,
    },
    deviceName: { color: t.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
    connLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    connVia: { color: t.text, fontSize: 14, fontWeight: '600' },
    connDot: { color: t.faint, fontSize: 14 },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 5,
      height: 24,
      paddingHorizontal: 9,
      borderRadius: 12,
    },
    chipText: { fontSize: 12, fontWeight: '600', letterSpacing: 0.1 },
    deviceTap: { flexDirection: 'row', alignItems: 'center', gap: 14, margin: -8, padding: 8, borderRadius: 18, borderCurve: 'continuous' },
    actions: {
      flexDirection: 'row',
      alignItems: 'center',
      padding: 3,
      borderRadius: 23,
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
    },
    action: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
    actionSep: { width: StyleSheet.hairlineWidth, height: 18, backgroundColor: t.line },
    actionBar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      height: 64,
      paddingLeft: 12,
      paddingRight: 8,
      borderRadius: 22,
      borderCurve: 'continuous',
      backgroundColor: t.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
      boxShadow: t.scheme === 'dark' ? '0 8px 24px rgba(0,0,0,0.5)' : '0 8px 24px rgba(20,24,10,0.12)',
    },
    barClose: { width: 36, height: 36, borderRadius: 18, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' },
    barCount: { flex: 1, color: t.text, fontSize: 15, fontWeight: '600', marginLeft: 4 },
    barBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 46,
      paddingHorizontal: 16,
      borderRadius: 15,
      borderCurve: 'continuous',
      backgroundColor: t.surface2,
    },
    barBtnText: { color: t.text, fontSize: 14, fontWeight: '600' },
    check: { width: 26, height: 26, borderRadius: 13, borderWidth: 2, alignItems: 'center', justifyContent: 'center', marginRight: 5 },
    devGroup: { backgroundColor: t.surface2, borderRadius: 18, borderCurve: 'continuous', overflow: 'hidden' },
    devRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      minHeight: 64,
      paddingHorizontal: 14,
      paddingVertical: 10,
      backgroundColor: t.surface2,
    },
    devSep: { height: StyleSheet.hairlineWidth, backgroundColor: t.line, marginLeft: 66 },
    devIcon: { width: 40, height: 40, borderRadius: 13, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
    devNow: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    devAction: { height: 30, paddingHorizontal: 12, borderRadius: 15, backgroundColor: t.surface3, justifyContent: 'center' },
    devActionText: { color: t.text, fontSize: 13, fontWeight: '600' },
    devLabel: { color: t.dim, fontSize: 14, fontWeight: '600', paddingHorizontal: 4 },

    panel: { padding: 18, borderRadius: 24, borderCurve: 'continuous', backgroundColor: t.surface },
    panelTitle: { color: t.text, fontSize: 15, fontWeight: '600' },
    speedRow: { flexDirection: 'row', alignItems: 'baseline', gap: 6, marginTop: 6, marginBottom: 14 },
    speed: { color: t.text, fontSize: 44, fontWeight: '700', letterSpacing: -1.5, fontVariant: ['tabular-nums'] },
    unit: { color: t.dim, fontSize: 16, fontWeight: '600' },
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 34,
      paddingHorizontal: 14,
      borderRadius: 17,
      backgroundColor: t.surface3,
    },
    pillText: { color: t.text, fontSize: 13, fontWeight: '600' },

    send: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      height: 60,
      borderRadius: 20,
      borderCurve: 'continuous',
      backgroundColor: t.accent, // under the gradient, in case it can't draw
      // flat, with just a hint of depth: a barely-there top-to-bottom shade, a faint rim,
      // 1px light on the top inner edge, 1px shade on the bottom, and a hairline shadow
      borderWidth: 1,
      borderColor: t.scheme === 'dark' ? '#B5E356' : '#42600A',
      experimental_backgroundImage:
        t.scheme === 'dark' ? 'linear-gradient(180deg, #CCF676 0%, #C2F065 100%)' : 'linear-gradient(180deg, #507308 0%, #476703 100%)',
      boxShadow:
        t.scheme === 'dark'
          ? 'inset 0 1px 0 rgba(255,255,255,0.3), inset 0 -1px 0 rgba(70,100,0,0.18), 0 1px 2px rgba(0,0,0,0.3)'
          : 'inset 0 1px 0 rgba(255,255,255,0.14), inset 0 -1px 0 rgba(0,0,0,0.1), 0 1px 2px rgba(40,60,0,0.2)',
    },
    sendText: { color: t.onAccent, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },

    empty: { alignItems: 'center', gap: 8, paddingVertical: 56, paddingHorizontal: 28 },
    emptyTitle: { color: t.text, fontSize: 17, fontWeight: '700', marginTop: 10 },

    sectionHead: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      paddingTop: 16,
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    sectionTitle: { color: t.text, fontSize: 17, fontWeight: '700', letterSpacing: -0.2 },
    textBtn: { paddingHorizontal: 12, height: 30, borderRadius: 15, justifyContent: 'center', backgroundColor: t.surface2 },
    textBtnLabel: { color: t.text, fontSize: 13, fontWeight: '600' },
    group: { backgroundColor: t.surface, borderRadius: 22, borderCurve: 'continuous', overflow: 'hidden' },
    cell: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      minHeight: 68,
      backgroundColor: t.surface,
    },
    sep: { position: 'absolute', top: 0, left: 70, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.line },
    cellText: { flex: 1, gap: 3 },
    name: { color: t.text, fontSize: 15, fontWeight: '600' },
    thumb: {
      width: 44,
      height: 44,
      borderRadius: 13,
      borderCurve: 'continuous',
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badge: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
    iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
    iconBtnSmall: { width: 30, height: 30, borderRadius: 15 },
    liveList: { gap: 12, marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
    liveRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    mini: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
    liveName: { color: t.text, fontSize: 14, fontWeight: '600' },
    panelFoot: { marginTop: 16, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
  });
