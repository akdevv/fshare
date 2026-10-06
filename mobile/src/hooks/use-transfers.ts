// Every transfer this phone is part of: downloads from the laptop, uploads to any device, and
// uploads another phone pushes to us. Files travel sealed (see cli/seal.ts): sealed before they
// leave, opened straight into the save folder when they arrive.
import { useEffect, useRef, useState } from 'react';
import { Directory, File, Paths } from 'expo-file-system';
import { Peer } from '../../modules/fshare-peer';
import type { Device } from '../lib/device';
import { placeFor } from '../lib/downloads';
import { client, me, signed } from '../lib/identity';
import { notify } from '../lib/notify';
import { haptic } from '../theme';

export type JobState = 'queued' | 'preparing' | 'active' | 'paused' | 'saving' | 'done' | 'cancelled' | 'error';
export type Job = {
  key: string;
  name: string;
  dir: 'up' | 'down';
  done: number;
  total: number;
  state: JobState;
  rate?: number;
  file?: File;
  retry?: () => void;
  peer?: string; // where it went, or where it came from
  incoming?: boolean; // pushed by another phone: only the sender can pause it
};
export type Remote = { id: number; path: string; size: number };

export const LIVE: JobState[] = ['queued', 'preparing', 'active', 'paused', 'saving'];
export const CANCELLABLE: JobState[] = ['queued', 'preparing', 'active', 'paused'];
const PARALLEL = 3; // a few at once keeps the link busy with many small files

type Control = { cancel: () => void; pause?: () => void };

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (queue.length) await fn(queue.shift()!);
    }),
  );
}

// The part of `src` after `offset` as a file of its own, so the native upload sends only that.
function tail(src: File, offset: number, dir: Directory): File {
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

export const baseName = (path: string) => path.split('/').pop()!;

// A sealed file that arrived whole, opened straight into the save folder so there's never a
// decrypted copy on the side. Rejects, leaving nothing behind, if it doesn't open.
async function openInto(root: Directory, token: string, sealed: File, relPath: string) {
  const dest = placeFor(root, relPath);
  try {
    await Peer!.openFile(token, sealed.uri, dest.uri);
  } catch (e) {
    try {
      dest.delete();
    } catch {}
    throw e;
  }
  sealed.delete();
  return dest;
}

const receivedSoFar = (url: string) =>
  fetch(url)
    .then((r) => r.json())
    .then((j) => (j.received as number) ?? 0)
    .catch(() => 0);

export function useTransfers({
  server,
  serverName,
  ensureSaveDir,
}: {
  server: Device;
  serverName: string;
  ensureSaveDir: () => Promise<Directory | null>;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [speed, setSpeed] = useState({ up: 0, down: 0 });
  const bytes = useRef({ up: 0, down: 0 });
  const controls = useRef(new Map<string, Control>());
  const resumers = useRef(new Map<string, { go: () => void; stop: (e: Error) => void }>());
  const stopped = useRef(new Set<string>());
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;

  // smoothed, sampled every 500 ms
  useEffect(() => {
    const t = setInterval(() => {
      const b = bytes.current;
      setSpeed((p) => ({ up: p.up * 0.4 + b.up * 1.2, down: p.down * 0.4 + b.down * 1.2 }));
      bytes.current = { up: 0, down: 0 };
    }, 500);
    return () => clearInterval(t);
  }, []);

  const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));
  const drop = (key: string) => setJobs((js) => js.filter((j) => j.key !== key));
  const add = (fresh: Job[]) => setJobs((js) => [...fresh, ...js]);

  // Native progress events come many times a second per file; the list re-renders at most every
  // 200 ms per file, and the state change that follows the last one shows the end.
  const progress = (key: string, dir: 'up' | 'down') => {
    let last = 0,
      mark = 0,
      at = Date.now(),
      shown = 0,
      rate = 0;
    const on = (done: number, total: number) => {
      if (stopped.current.has(key)) return;
      bytes.current[dir] += done - last;
      last = done;
      const now = Date.now();
      if (now - at >= 500) {
        const instant = (done - mark) / ((now - at) / 1000);
        rate = rate ? rate * 0.5 + instant * 0.5 : instant;
        mark = done;
        at = now;
      }
      if (now - shown < 200) return;
      shown = now;
      patch(key, total > 0 ? { done, total, rate } : { done, rate });
    };
    return Object.assign(on, {
      reset: (from = 0) => {
        last = from;
        mark = from;
        rate = 0;
        at = Date.now();
        shown = 0;
      },
    });
  };

  // a paused transfer waits here until it's resumed, or cancelled (rejects)
  const waitForResume = (key: string) => new Promise<void>((go, stop) => resumers.current.set(key, { go, stop }));
  const isStopped = (key: string) => stopped.current.has(key);

  const run = async (key: string, work: () => Promise<void>) => {
    if (isStopped(key)) return; // cancelled while queued
    patch(key, { state: 'active' });
    try {
      await work();
    } catch (e) {
      if (!isStopped(key)) console.warn(`[fshare] transfer ${key} failed:`, e);
      patch(key, { state: isStopped(key) ? 'cancelled' : 'error', rate: 0 });
    }
    controls.current.delete(key);
    resumers.current.delete(key);
  };

  // One haptic and, when minimized, one notification per batch. A batch goes one way, to or from
  // one device. Runs after the last state update has rendered.
  const finished = (keys: string[]) =>
    setTimeout(() => {
      const batch = jobsRef.current.filter((j) => keys.includes(j.key));
      const failed = batch.filter((j) => j.state === 'error');
      const done = batch.filter((j) => j.state === 'done');
      if (failed.length) haptic.error();
      else if (done.length) haptic.success();
      const names = (js: Job[]) => summary(js.map((j) => baseName(j.name)));
      const up = batch[0]?.dir === 'up';
      const peer = batch[0]?.peer ?? serverName;
      if (failed.length)
        notify(
          up ? `Couldn't send to ${peer}` : `Couldn't receive from ${peer}`,
          up ? `${names(failed)}. Open fshare to retry.` : names(failed),
        );
      else if (done.length) notify(up ? `Sent to ${peer}` : `Received from ${peer}`, names(done));
    }, 100);

  // false when there's nowhere to save (no folder chosen)
  const download = async (items: Remote[]) => {
    const root = await ensureSaveDir();
    if (!root) return false;
    const batch = items.map((r) => ({ r, key: `d${r.id}-${Date.now()}` }));
    const retry = (r: Remote, key: string) => () => {
      drop(key);
      download([r]);
    };
    add(
      batch.map(({ r, key }) => ({
        key,
        name: r.path,
        dir: 'down',
        done: 0,
        total: r.size,
        state: 'queued',
        peer: serverName,
        retry: retry(r, key),
      })),
    );
    await pool(batch, PARALLEL, async ({ r, key }) => {
      const dir = new Directory(Paths.cache, 'fshare', key);
      await run(key, async () => {
        try {
          const on = progress(key, 'down');
          dir.create({ intermediates: true, idempotent: true });
          const sealed = new File(dir, '.sealed');
          const start = () => {
            const task = File.createDownloadTask(signed(server, `/file/${r.id}`), sealed, {
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
            if (isStopped(key)) throw new Error('cancelled');
            patch(key, { state: 'paused', rate: 0 });
            await waitForResume(key);
            patch(key, { state: 'active' });
            try {
              out = await task.resumeAsync();
            } catch (e) {
              if (isStopped(key)) throw e;
              // no resume data: start this file over instead of failing
              if (sealed.exists) sealed.delete();
              on.reset();
              patch(key, { done: 0 });
              task = start();
              out = await task.downloadAsync();
            }
          }
          if (isStopped(key)) throw new Error('cancelled');
          patch(key, { state: 'saving', done: r.size });
          const saved = await openInto(root, server.token, sealed, r.path);
          patch(key, { state: 'done', file: saved });
        } finally {
          try {
            dir.delete();
          } catch {}
        }
      });
    });
    finished(batch.map((b) => b.key));
    return true;
  };

  // `to` defaults to the device on screen. `again` retries one file under its old id, so the
  // other side carries on from what it kept (for 5 minutes).
  const upload = async (files: File[], to: Device = server, again?: string) => {
    const url = (p: string, method = 'GET') => signed(to, p, method);
    const toName = to.id === server.id ? serverName : to.name;
    const batch = files.map((f, i) => ({ f, key: again ?? `u${Date.now()}-${i}` }));
    if (again) stopped.current.delete(again);
    const retry = (f: File, key: string) => () => {
      drop(key);
      upload([f], to, key);
    };
    add(
      batch.map(({ f, key }) => ({
        key,
        name: f.name,
        dir: 'up',
        done: 0,
        total: f.size,
        state: 'queued',
        peer: toName,
        retry: retry(f, key),
      })),
    );
    await pool(batch, PARALLEL, async ({ f, key }) => {
      const dir = new Directory(Paths.cache, 'fshare-up', key);
      await run(key, async () => {
        try {
          await send(f, key, dir, to, url, again);
        } finally {
          try {
            dir.delete();
          } catch {}
        }
      });
    });
    finished(batch.map((b) => b.key));
  };

  const send = async (f: File, key: string, dir: Directory, to: Device, url: (p: string, method?: string) => string, again?: string) => {
    controls.current.set(key, { cancel: () => {} }); // sealing can't be interrupted; checked right after
    // Sealed for `to` straight from the original (Android's content:// URIs too), so the only
    // extra space is the sealed copy. The same id always seals to the same bytes, so a retry
    // carries on from what the other side kept.
    patch(key, { state: 'preparing' });
    dir.create({ intermediates: true, idempotent: true });
    const sealed = new File(dir, '.sealed');
    let info: { size: number; name: string | null };
    try {
      info = await Peer!.sealFile(to.token, f.uri, sealed.uri, key);
    } catch {
      // a provider that won't say how big the file is: copy it in first, then seal the copy
      await f.copy(dir);
      const copy = dir.list().find((e) => e instanceof File && e.name !== '.sealed') as File;
      info = await Peer!.sealFile(to.token, copy.uri, sealed.uri, key);
      copy.delete();
    }
    if (isStopped(key)) throw new Error('cancelled');
    const name = info.name ?? f.name; // the real name, not "msf:1000113138"
    patch(key, { state: 'active', name });
    const on = progress(key, 'up');
    const size = sealed.size;
    let offset = again ? await receivedSoFar(url(`/upload?id=${key}`)).then((n) => (n <= size ? n : 0)) : 0;
    on.reset(offset);
    if (offset) patch(key, { done: offset });
    for (;;) {
      const ctrl = new AbortController();
      let pausing = false;
      controls.current.set(key, {
        cancel: () => {
          ctrl.abort();
          fetch(url(`/upload?id=${key}`, 'DELETE'), { method: 'DELETE' }).catch(() => {});
        },
        pause: () => {
          pausing = true;
          ctrl.abort();
        },
      });
      try {
        const body = offset ? tail(sealed, offset, dir) : sealed;
        const sealedName = Peer!.seal(to.token, name); // base64url: safe in a URL as is
        const r = await body.upload(url(`/upload?name=${sealedName}&id=${key}&offset=${offset}&size=${size}`, 'PUT'), {
          httpMethod: 'PUT',
          headers: client(to.token),
          signal: ctrl.signal,
          onProgress: ({ bytesSent }) => on(offset + bytesSent, size),
        });
        if (r.status === 409) {
          // the other side has less than we thought
          offset = JSON.parse(r.body).received;
          on.reset(offset);
          continue;
        }
        if (r.status !== 200) throw new Error(r.body);
        break;
      } catch (e) {
        if (!pausing || isStopped(key)) throw e;
        patch(key, { state: 'paused', rate: 0 });
        await waitForResume(key);
        patch(key, { state: 'active' });
        offset = await receivedSoFar(url(`/upload?id=${key}`));
        on.reset(offset);
        patch(key, { done: offset });
      }
    }
    patch(key, { state: 'done', done: f.size });
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
  const each = (states: JobState[], fn: (key: string) => void) => jobs.filter((j) => states.includes(j.state)).forEach((j) => fn(j.key));

  // Another phone pushing files to us: its upload streams into the native server, which reports
  // progress here; once it's all in, it's opened into the save folder like any download.
  const incoming = useRef(new Map<string, string>()); // upload id → job key
  const lastDone = useRef(new Map<string, number>());
  const onPeer = useRef({
    progress: (_e: { id: string; name: string; from: string; done: number; total: number }) => {},
    received: (_e: { id: string; name: string; uri: string; size: number }) => {},
    stopped: (_e: { id: string; reason: 'paused' | 'cancelled' | 'expired' }) => {},
  });
  onPeer.current = {
    progress: ({ id, name, from, done, total }) => {
      const key = incoming.current.get(id);
      if (!key || !jobsRef.current.some((j) => j.key === key && LIVE.includes(j.state))) {
        const earlier = key; // a finished or failed earlier try of this upload: this one replaces it
        const fresh = `in-${id}-${Date.now()}`;
        incoming.current.set(id, fresh);
        lastDone.current.set(id, done);
        controls.current.set(fresh, { cancel: () => Peer?.cancel(id) });
        setJobs((js) => [
          { key: fresh, name, dir: 'down', done, total, state: 'active', peer: from, incoming: true },
          ...js.filter((j) => j.key !== earlier),
        ]);
        return;
      }
      const prev = lastDone.current.get(id) ?? done;
      bytes.current.down += Math.max(0, done - prev);
      lastDone.current.set(id, done);
      patch(key, { done, total, state: 'active', rate: (done - prev) * 4 }); // events come every ~250 ms
    },
    stopped: ({ id, reason }) => {
      const key = incoming.current.get(id);
      if (!key) return;
      // paused: the sender can still resume it; expired: kept 5 minutes and never resumed
      patch(key, { state: reason === 'paused' ? 'paused' : reason === 'expired' ? 'error' : 'cancelled', rate: 0 });
      if (reason === 'paused') return;
      controls.current.delete(key);
      finished([key]);
    },
    received: async ({ id, name, uri, size }) => {
      const key = incoming.current.get(id);
      if (!key) return;
      patch(key, { state: 'saving', done: size, rate: 0 });
      controls.current.delete(key);
      const root = await ensureSaveDir();
      try {
        if (!root) throw new Error('no save folder');
        patch(key, { state: 'done', file: await openInto(root, me.token, new File(uri), name) });
      } catch (e) {
        // didn't open (not sealed with our token, or damaged on the way), or couldn't be saved
        console.warn('[fshare] saving a received file failed:', e);
        patch(key, { state: 'error' });
        try {
          new File(uri).delete();
        } catch {}
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
    return () => subs.forEach((s) => s.remove());
  }, []);

  return {
    jobs,
    setJobs,
    speed: speed.up + speed.down,
    download,
    upload,
    pause,
    resume,
    cancel,
    cancelAll: () => each(CANCELLABLE, cancel),
    pauseAll: () => each(['active'], pause),
    resumeAll: () => each(['paused'], resume),
    clearFinished: () => setJobs((js) => js.filter((j) => LIVE.includes(j.state))),
  };
}
