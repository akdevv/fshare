import { useEffect, useRef, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { readPrefs, writePrefs, type SavedPeer } from './prefs';
import { Session, SavedList, VisibilityRow, type Device } from './session';
import { Behind, Sheet, type SheetContent } from './sheet';
import { Onboarding } from './onboarding';
import { Splash } from './splash';
import { CABLE, Peer, SERVER_PORT, type Found } from './modules/fshare-peer';
import { me } from './identity';
import { Ionicons } from '@expo/vector-icons';
import { haptic, ThemeProvider, useStyles, useTheme, type Theme } from './theme';
import Animated, { Easing, FadeInDown, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import { Cookie, EASE_OUT, Press } from './ui';
import {
  useFonts,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
} from '@expo-google-fonts/plus-jakarta-sans';

// `fshare` on the laptop tunnels this port over the USB cable (adb reverse) when the phone is plugged in
const USB = 'http://127.0.0.1:4747';

async function get(url: string, ms = 1500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? await r.text() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// Files shared into fshare from another app (Gallery › Share › fshare). Only the installed app
// can receive shares; in Expo Go the native side is missing, so this quietly does nothing.
const canReceive = (() => {
  try {
    Sharing.getSharedPayloads();
    return true;
  } catch {
    return false;
  }
})();
const useIncomingShare = canReceive ? Sharing.useIncomingShare : () => null;

function useOutbox() {
  const share = useIncomingShare();
  const [outbox, setOutbox] = useState<File[]>([]);
  const payloads = share?.resolvedSharedPayloads ?? [];
  useEffect(() => {
    if (!payloads.length) return;
    const files = payloads.flatMap((p): File[] => {
      if (p.contentUri && p.contentType !== 'text' && p.contentType !== 'website') return [new File(p.contentUri)];
      if (!p.value) return [];
      const f = new File(Paths.cache, `Shared text ${new Date().toISOString().slice(0, 19).replace(/:/g, '.')}.txt`); // a shared link or note
      f.write(p.value);
      return [f];
    });
    share!.clearSharedPayloads();
    setOutbox((o) => [...o, ...files]);
  }, [payloads]);
  return [outbox, () => setOutbox([])] as const;
}

export default function App() {
  // the native splash stays up until the typeface is ready, so text never flashes in another font
  const [fonts] = useFonts({
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
  });
  if (!fonts) return null;
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}

// where a device was found, most preferred first: a cable beats Wi-Fi
const RANK = ['laptop-usb', 'cable', 'laptop-wifi'];

const phone = (p: SavedPeer): Device => ({ id: `phone-${p.id}`, name: p.name, base: p.base, token: p.token, kind: 'phone', via: 'wifi' });

function Root() {
  const t = useTheme();
  const [devices, setDevices] = useState<Device[]>([]); // reachable right now
  const [current, setCurrent] = useState<Device | null>(null);
  const [nearby, setNearby] = useState<Found[]>([]); // phones on this Wi-Fi we haven't paired with
  const [qr, setQr] = useState(false); // showing the Wi-Fi QR scanner
  const [sheet, setSheet] = useState<SheetContent | null>(null);
  const [outbox, clearOutbox] = useOutbox();
  const [onboarded, setOnboarded] = useState(() => !!readPrefs().onboarded);
  const [saved, setSaved] = useState<SavedPeer[]>(() => readPrefs().peers ?? []); // phones paired over Wi-Fi, kept across launches
  const [visible, setVisible] = useState(() => !readPrefs().hidden);
  const cur = useRef(current);
  cur.current = current;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;

  const remember = (p: SavedPeer) => {
    const next = [...savedRef.current.filter((x) => x.id !== p.id), p];
    savedRef.current = next;
    writePrefs({ peers: next });
    setSaved(next);
  };
  const forget = (p: SavedPeer) => {
    const next = savedRef.current.filter((x) => x.id !== p.id);
    savedRef.current = next;
    writePrefs({ peers: next });
    setSaved(next);
    setDevices((ds) => ds.filter((d) => d.id !== `phone-${p.id}`));
    if (cur.current?.id === `phone-${p.id}`) setCurrent(null);
  };
  const askForget = (p: SavedPeer) => {
    haptic.reject();
    setSheet({
      title: `Forget ${p.name}?`,
      message: "To send files to each other again, you'll need to pair again.",
      actions: [{ label: 'Forget', icon: 'trash-outline', destructive: true, onPress: () => forget(p) }],
    });
  };
  const changeVisible = (v: boolean) => {
    setVisible(v);
    writePrefs({ hidden: !v });
    Peer?.setVisible(v);
  };

  const choose = (d: Device) => {
    setCurrent(d);
    setQr(false);
  };

  // Peer server + discovery (installed Android app only)
  useEffect(() => {
    if (!Peer) return;
    Peer.start(me.token, me.name, me.id, !readPrefs().hidden);
    const subs = [
      Peer.addListener('peerFound', (f) => f.id !== me.id && setNearby((n) => [...n.filter((x) => x.name !== f.name), f])),
      Peer.addListener('peerLost', ({ name }) => setNearby((n) => n.filter((x) => x.name !== name))),
      // another phone tapped us in its list: ask before letting it in
      Peer.addListener('pairRequest', (r) => {
        haptic.select();
        setSheet({
          title: `${r.name} wants to connect`,
          message: 'Accept to send files to each other over Wi-Fi.',
          actions: [
            {
              label: 'Accept',
              icon: 'checkmark',
              onPress: () => {
                Peer!.answerPair(r.id, true);
                const p = { id: r.peer || r.host, name: r.name, token: r.token, base: `http://${r.host}:${r.port}` };
                remember(p);
                const d = phone(p);
                setDevices((ds) => [...ds.filter((x) => x.id !== d.id), d]);
                choose(d);
              },
            },
            { label: 'Decline', icon: 'close', destructive: true, onPress: () => Peer!.answerPair(r.id, false) },
          ],
          onCancel: () => Peer!.answerPair(r.id, false),
        });
      }),
    ];
    return () => subs.forEach((s) => s.remove());
  }, []);

  // Auto-connect: every 2 s, see which devices answer. A cable pairs by itself (the other side
  // only hands its token to the cable); Wi-Fi uses the laptop's QR pairing or phone pairing.
  useEffect(() => {
    if (qr && !cur.current) return; // user is scanning on purpose; don't yank them away
    let alive = true;
    const name = async (base: string, token: string) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      try {
        const r = await fetch(`${base}/list?t=${token}`, {
          signal: ctrl.signal,
          headers: { 'x-fshare-client': encodeURIComponent(me.name) },
        });
        if (!r.ok) return null;
        return {
          name: decodeURIComponent(r.headers.get('x-fshare-name') ?? '') || 'Device',
          kind: r.headers.get('x-fshare-kind') === 'phone' ? ('phone' as const) : ('laptop' as const),
        };
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    };
    const probe = async () => {
      const found: Device[] = [];
      const usbToken = await get(`${USB}/pair`);
      if (usbToken) {
        if (usbToken !== readPrefs().token) writePrefs({ token: usbToken });
        found.push({
          id: 'laptop-usb',
          name: (await name(USB, usbToken))?.name ?? 'Laptop',
          base: USB,
          token: usbToken,
          kind: 'laptop',
          via: 'usb',
        });
      }
      // the accessory cable: another phone, or a laptop when USB debugging is off (then adb isn't there)
      if (Peer && Platform.OS === 'android' && !usbToken) {
        const cableToken = await get(`${CABLE}/pair`);
        const n = cableToken && (await name(CABLE, cableToken));
        if (cableToken && n) {
          if (n.kind === 'laptop' && cableToken !== readPrefs().token) writePrefs({ token: cableToken });
          found.push({ id: 'cable', name: n.name, base: CABLE, token: cableToken, kind: n.kind, via: 'usb' });
        }
      }
      const { token, lan } = readPrefs();
      if (!usbToken && token && lan) {
        const n = await name(lan, token);
        if (n && !found.some((d) => d.kind === 'laptop'))
          found.push({ id: 'laptop-wifi', name: n.name, base: lan, token, kind: 'laptop', via: 'wifi' });
      }
      // paired phones: try the address it's announcing now, else where it was last time
      const back = await Promise.all(
        savedRef.current.map(async (p) => {
          const f = nearbyRef.current.find((x) => x.id === p.id);
          const base = f ? `http://${f.host}:${f.port}` : p.base;
          const n = await name(base, p.token);
          return n && { ...p, base, name: n.name };
        }),
      );
      for (const p of back) {
        if (!p) continue;
        const old = savedRef.current.find((x) => x.id === p.id);
        if (old && (old.base !== p.base || old.name !== p.name)) remember(p);
        found.push(phone(p));
      }
      if (!alive) return;
      setDevices(found);
      const now = cur.current;
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
  }, [qr]);

  // ask a nearby phone to connect; its owner sees "<this phone> wants to connect"
  const pair = async (f: Found) => {
    haptic.tap();
    const ctrl = new AbortController();
    setSheet({
      title: `Waiting for ${f.name}`,
      message: `Tap Accept on ${f.name} to connect.`,
      actions: [],
      onCancel: () => ctrl.abort(),
    });
    const timer = setTimeout(() => ctrl.abort(), 65000);
    try {
      const base = `http://${f.host}:${f.port}`;
      const r = await fetch(`${base}/hello?name=${encodeURIComponent(me.name)}&port=${SERVER_PORT}&token=${me.token}&id=${me.id}`, {
        method: 'POST',
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error('declined');
      const p = { id: f.id || f.host, name: f.name, token: await r.text(), base };
      remember(p);
      const d = phone(p);
      setDevices((ds) => [...ds.filter((x) => x.id !== d.id), d]);
      setSheet(null);
      haptic.success();
      choose(d);
    } catch {
      if (ctrl.signal.aborted && !sheetOpen.current) return; // user cancelled
      haptic.error();
      setSheet({
        title: `Couldn't connect to ${f.name}`,
        message: 'They declined, or the phone is out of reach. Make sure both phones are on the same Wi-Fi or hotspot.',
        actions: [],
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const sheetOpen = useRef(false);
  sheetOpen.current = !!sheet;

  const scanned = (d: Device) => {
    haptic.success();
    writePrefs({ token: d.token, lan: d.base });
    setQr(false);
    setCurrent(d);
  };

  // phones to offer pairing with: not hidden, not already paired
  const others = nearby.filter(
    (f) => !f.hidden && !saved.some((p) => p.id === f.id) && !devices.some((d) => d.base === `http://${f.host}:${f.port}`),
  );
  const away = saved.filter((p) => !devices.some((d) => d.id === `phone-${p.id}`)); // paired, not reachable right now
  return (
    // black shows around the screen when a sheet pushes it back
    <SafeAreaProvider style={{ backgroundColor: '#000' }}>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Behind style={{ backgroundColor: t.bg }}>
        {!onboarded ? (
          <Onboarding
            onDone={() => {
              writePrefs({ onboarded: true });
              setOnboarded(true);
            }}
          />
        ) : current ? (
          <Session
            device={current}
            devices={devices}
            nearby={others}
            away={away}
            saved={saved}
            onForget={askForget}
            visible={visible}
            onVisible={changeVisible}
            outbox={outbox}
            clearOutbox={clearOutbox}
            onPick={(d) => {
              haptic.select();
              choose(d);
            }}
            onPair={pair}
            onWifi={() => {
              setQr(true);
              setCurrent(null);
            }}
          />
        ) : qr ? (
          <Scanner onConnect={scanned} onBack={() => setQr(false)} />
        ) : (
          <Waiting
            onWifi={() => setQr(true)}
            nearby={others}
            onPair={pair}
            outbox={outbox.length}
            away={away}
            onForget={askForget}
            visible={visible}
            onVisible={changeVisible}
          />
        )}
      </Behind>
      <Sheet content={sheet} onClose={() => setSheet(null)} />
      <Splash />
    </SafeAreaProvider>
  );
}

// Cookie-shaped ripples drifting out from the hero while it searches. Off with reduced motion.
function Ripple({ delay }: { delay: number }) {
  const t = useTheme();
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        opacity: 0,
        animationName: { from: { opacity: 0.5, transform: [{ scale: 1 }] }, to: { opacity: 0, transform: [{ scale: 1.55 }] } },
        animationDuration: '2.8s',
        animationDelay: `${delay}s`,
        animationIterationCount: 'infinite',
        animationTimingFunction: EASE_OUT,
      }}
    >
      <Cookie size={136} color={t.accent} outline />
    </Animated.View>
  );
}

function Waiting({
  onWifi,
  nearby,
  onPair,
  outbox,
  away,
  onForget,
  visible,
  onVisible,
}: {
  onWifi: () => void;
  nearby: Found[];
  onPair: (f: Found) => void;
  outbox: number;
  away: SavedPeer[];
  onForget: (p: SavedPeer) => void;
  visible: boolean;
  onVisible: (v: boolean) => void;
}) {
  const [st, t] = useStyles(styles);
  const reduced = useReducedMotion();
  const phones = !!Peer; // the installed Android app can also connect to other phones
  return (
    <SafeAreaView style={st.root}>
      <View style={st.body}>
        <View style={st.heroWrap}>
          {!reduced && (
            <>
              <Ripple delay={0} />
              <Ripple delay={1.4} />
            </>
          )}
          <Cookie size={136} color={t.accentSoft} spin={24}>
            <Ionicons name={phones ? 'swap-horizontal' : 'laptop-outline'} size={46} color={t.onAccentSoft} />
          </Cookie>
        </View>
        <Animated.Text entering={rise(0)} style={st.looking}>
          {phones ? 'Looking for devices…' : 'Looking for your laptop…'}
        </Animated.Text>
        <Animated.Text entering={rise(70)} style={st.title}>
          {phones ? 'Connect a device' : 'Connect to your laptop'}
        </Animated.Text>
        <Animated.Text entering={rise(140)} style={st.text}>
          {!phones
            ? 'Plug in the USB cable and run fshare on your laptop. It connects by itself.'
            : Platform.OS === 'ios'
              ? 'Pick a phone nearby, or scan the QR code from fshare on your laptop.'
              : 'Plug a USB cable into your laptop (running fshare) or another phone, or pick a phone nearby.'}
        </Animated.Text>
        {outbox > 0 && (
          <Animated.View entering={rise(0)} style={st.outbox}>
            <Ionicons name="arrow-up-circle" size={18} color={t.onAccentSoft} />
            <Text style={st.outboxText}>
              {outbox} {outbox === 1 ? 'file' : 'files'} ready to send. Connect a device to choose where.
            </Text>
          </Animated.View>
        )}
      </View>
      {nearby.length > 0 && (
        <Animated.View entering={rise(0)} style={{ gap: 10, marginBottom: 12 }}>
          <Text style={st.nearbyTitle}>Nearby</Text>
          <View style={st.group}>
            {nearby.map((f, i) => (
              <Press
                key={f.name}
                style={[st.row, i > 0 && st.rowSep]}
                highlight={t.surface2}
                onPress={() => onPair(f)}
                accessibilityRole="button"
                accessibilityLabel={`Connect to ${f.name}`}
              >
                <View style={st.rowIcon}>
                  <Ionicons name="phone-portrait-outline" size={18} color={t.onAccentSoft} />
                </View>
                <Text style={st.rowText} numberOfLines={1}>
                  {f.name}
                </Text>
                <Text style={st.rowAction}>Connect</Text>
              </Press>
            ))}
          </View>
        </Animated.View>
      )}
      {phones && away.length > 0 && (
        <Animated.View entering={rise(0)} style={{ gap: 10, marginBottom: 12 }}>
          <Text style={st.nearbyTitle}>Your phones</Text>
          <SavedList peers={away} onForget={onForget} />
        </Animated.View>
      )}
      {phones && (
        <Animated.View entering={rise(210)} style={{ marginBottom: 12 }}>
          <VisibilityRow visible={visible} onChange={onVisible} />
        </Animated.View>
      )}
      <Animated.View entering={rise(210)}>
        <Press
          style={st.secondary}
          onPress={() => {
            haptic.tap();
            onWifi();
          }}
          accessibilityRole="button"
          accessibilityLabel="Connect to a laptop over Wi-Fi"
        >
          <Ionicons name="qr-code-outline" size={18} color={t.text} />
          <Text style={st.secondaryText}>Connect over Wi-Fi</Text>
        </Press>
      </Animated.View>
    </SafeAreaView>
  );
}

// gentle fade-up on first appearance, staggered by `delay` ms
const rise = (delay: number) =>
  FadeInDown.delay(delay)
    .duration(420)
    .easing(Easing.bezier(0.23, 1, 0.32, 1))
    .withInitialValues({ transform: [{ translateY: 10 }] })
    .reduceMotion(ReduceMotion.System);

function Scanner({ onConnect, onBack }: { onConnect: (d: Device) => void; onBack: () => void }) {
  const [st, t] = useStyles(styles);
  const [perm, requestPerm] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [error, setError] = useState(false);
  const busy = useRef(false); // camera fires onBarcodeScanned many times per second

  const connect = (raw: string) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const u = new URL(raw.trim());
      const token = u.searchParams.get('t');
      if (!token) throw new Error();
      onConnect({ id: 'laptop-wifi', name: 'Laptop', base: `${u.protocol}//${u.host}`, token, kind: 'laptop', via: 'wifi' });
    } catch {
      haptic.error();
      setError(true);
      setTimeout(() => (busy.current = false), 1500); // don't re-flag the same wrong code every frame
    }
  };

  return (
    <SafeAreaView style={st.root}>
      <Animated.View entering={rise(0)} style={{ paddingTop: 24, gap: 6 }}>
        <Text style={[st.title, { textAlign: 'left' }]}>Connect over Wi-Fi</Text>
        <Text style={[st.text, { textAlign: 'left' }]}>In the fshare terminal, type q and press Enter, then scan the code.</Text>
      </Animated.View>

      <Animated.View entering={rise(60)} style={st.camera}>
        {perm?.granted ? (
          <>
            <CameraView
              style={StyleSheet.absoluteFill}
              barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
              onBarcodeScanned={({ data }) => connect(data)}
            />
            <Viewfinder error={error} />
          </>
        ) : (
          <View style={st.center}>
            <Cookie size={84} color={t.accentSoft}>
              <Ionicons name="camera-outline" size={30} color={t.onAccentSoft} />
            </Cookie>
            <Text style={[st.text, { marginTop: 16, marginBottom: 18, paddingHorizontal: 32 }]}>Allow camera access to scan the code.</Text>
            <Press
              style={st.allow}
              onPress={() => {
                haptic.tap();
                requestPerm();
              }}
              accessibilityRole="button"
            >
              <Text style={st.allowText}>Allow camera</Text>
            </Press>
          </View>
        )}
      </Animated.View>

      <Animated.View entering={rise(120)} style={{ gap: 12 }}>
        <View style={[st.inputRow, error && { borderColor: t.red }]}>
          <Ionicons name="link-outline" size={18} color={t.dim} />
          <TextInput
            style={st.input}
            placeholder="Or paste the link"
            placeholderTextColor={t.faint}
            autoCapitalize="none"
            autoCorrect={false}
            value={manual}
            onChangeText={(v) => {
              setManual(v);
              setError(false);
            }}
            onSubmitEditing={() => connect(manual)}
            returnKeyType="go"
          />
        </View>
        {error && (
          <Animated.Text entering={rise(0)} style={[st.text, { color: t.red, fontSize: 13, textAlign: 'left' }]}>
            That isn't an fshare code.
          </Animated.Text>
        )}
      </Animated.View>

      <View style={{ flex: 1 }} />
      <Press
        style={st.secondary}
        onPress={() => {
          haptic.tap();
          onBack();
        }}
        accessibilityRole="button"
        accessibilityLabel="Use USB cable instead"
      >
        <Ionicons name="flash" size={18} color={t.text} />
        <Text style={st.secondaryText}>Use USB cable instead</Text>
      </Press>
    </SafeAreaView>
  );
}

// Four thin corner brackets that breathe slowly; red when the scanned code isn't fshare's.
function Viewfinder({ error }: { error: boolean }) {
  const [st, t] = useStyles(styles);
  const reduced = useReducedMotion();
  const color = error ? t.red : t.accent;
  const corner = (pos: object, edges: object) => (
    <Animated.View style={[st.corner, pos, edges, { borderColor: color, transitionProperty: 'borderColor', transitionDuration: 200 }]} />
  );
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        st.finder,
        !reduced && {
          animationName: {
            '0%': { transform: [{ scale: 1 }] },
            '50%': { transform: [{ scale: 0.96 }] },
            '100%': { transform: [{ scale: 1 }] },
          },
          animationDuration: '2.4s',
          animationIterationCount: 'infinite',
          animationTimingFunction: 'ease-in-out',
        },
      ]}
    >
      {corner({ top: 0, left: 0 }, { borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 16 })}
      {corner({ top: 0, right: 0 }, { borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 16 })}
      {corner({ bottom: 0, left: 0 }, { borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 16 })}
      {corner({ bottom: 0, right: 0 }, { borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 16 })}
    </Animated.View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16 },
    heroWrap: { width: 136, height: 136, alignItems: 'center', justifyContent: 'center', marginBottom: 36 },
    looking: { color: t.accent, fontSize: 13, fontWeight: '600', letterSpacing: 0.2, marginBottom: 4 },
    title: { color: t.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.6, textAlign: 'center' },
    text: { color: t.dim, fontSize: 15, lineHeight: 22, textAlign: 'center' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    secondary: {
      flexDirection: 'row',
      gap: 8,
      height: 56,
      borderRadius: 18,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 12,
      backgroundColor: t.surface2,
    },
    secondaryText: { color: t.text, fontSize: 16, fontWeight: '600' },
    camera: {
      width: '100%',
      aspectRatio: 1,
      borderRadius: 28,
      borderCurve: 'continuous',
      overflow: 'hidden',
      backgroundColor: t.surface,
      marginTop: 24,
      marginBottom: 20,
    },
    finder: { position: 'absolute', top: '22%', left: '22%', right: '22%', bottom: '22%' },
    corner: { position: 'absolute', width: 30, height: 30 },
    allow: {
      height: 48,
      paddingHorizontal: 24,
      borderRadius: 24,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.accent,
    },
    allowText: { color: t.onAccent, fontSize: 15, fontWeight: '700' },
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      borderRadius: 18,
      borderCurve: 'continuous',
      backgroundColor: t.surface,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    input: { flex: 1, color: t.text, fontSize: 15, paddingVertical: 16 },
    outbox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 18,
      paddingHorizontal: 14,
      height: 36,
      borderRadius: 18,
      backgroundColor: t.accentSoft,
    },
    outboxText: { color: t.onAccentSoft, fontSize: 13, fontWeight: '600' },
    nearbyTitle: { color: t.dim, fontSize: 14, fontWeight: '600', paddingHorizontal: 4 },
    group: { backgroundColor: t.surface, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 58, paddingHorizontal: 14, backgroundColor: t.surface },
    rowSep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
    rowIcon: {
      width: 34,
      height: 34,
      borderRadius: 11,
      borderCurve: 'continuous',
      backgroundColor: t.accentSoft,
      alignItems: 'center',
      justifyContent: 'center',
    },
    rowText: { flex: 1, color: t.text, fontSize: 16, fontWeight: '600' },
    rowAction: { color: t.accent, fontSize: 14, fontWeight: '700' },
  });
