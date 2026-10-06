import { useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { JetBrainsMono_500Medium } from '@expo-google-fonts/jetbrains-mono';
import {
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  PlusJakartaSans_800ExtraBold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { Peer, type Found, type PairRequest } from '../modules/fshare-peer';
import { PairCard } from './components/pair-card';
import { Behind, Sheet, type SheetContent } from './components/sheet';
import { Splash } from './components/splash';
import { CableSteps } from './components/steps';
import { useDevices } from './hooks/use-devices';
import { useOutbox } from './hooks/use-outbox';
import { NO_DEVICE, type Device } from './lib/device';
import { pairWith } from './lib/pairing';
import { readPrefs, writePrefs } from './lib/prefs';
import { ConnectScreen } from './screens/devices';
import { MainScreen } from './screens/main';
import { Onboarding } from './screens/onboarding';
import { Scanner } from './screens/scanner';
import { haptic, ThemeProvider, useTheme } from './theme';

export default function App() {
  // the native splash stays up until the fonts are in, so text never flashes in another one
  const [fonts] = useFonts({
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
    PlusJakartaSans_800ExtraBold,
    JetBrainsMono_500Medium,
  });
  if (!fonts) return null;
  return (
    <ThemeProvider>
      <Root />
    </ThemeProvider>
  );
}

function Root() {
  const t = useTheme();
  const [onboarded, setOnboarded] = useState(() => !!readPrefs().onboarded);
  const [skipped, setSkipped] = useState(false); // on to the main screen with nothing connected
  const [scanning, setScanning] = useState(false);
  const [sheet, setSheet] = useState<SheetContent | null>(null);
  const sheetOpen = useRef(false);
  sheetOpen.current = !!sheet;
  const [outbox, clearOutbox] = useOutbox();

  // another phone asked to pair: its owner and ours each check the code before accepting
  const pairRequest = (r: PairRequest) => {
    haptic.select();
    const answer = (ok: boolean) => {
      Peer!.answerPair(r.id, ok);
      setSheet(null);
      if (!ok) return haptic.reject();
      haptic.success();
      choose(paired({ id: r.peer || r.host, name: r.name, token: r.token, base: `http://${r.host}:${r.port}`, e2e: true }));
    };
    setSheet({
      title: '',
      actions: [],
      hideClose: true,
      extra: (
        <PairCard
          them={r.name}
          line="wants to connect"
          code={r.code}
          note={`Accept only if ${r.name} shows the same code.`}
          actions={[
            { label: 'Decline', onPress: () => answer(false) },
            { label: 'Accept', primary: true, onPress: () => answer(true) },
          ]}
        />
      ),
      onCancel: () => Peer!.answerPair(r.id, false),
    });
  };

  const { devices, current, setCurrent, nearby, saved, visible, changeVisible, forget, paired } = useDevices({
    scanning,
    onPairRequest: pairRequest,
  });

  const choose = (d: Device) => {
    setCurrent(d);
    setScanning(false);
  };

  const cableHelp = () => setSheet({ title: 'Connect with a cable', extra: <CableSteps />, actions: [], closeLabel: 'Got it' });

  const pair = async (f: Found) => {
    haptic.tap();
    const ctrl = new AbortController();
    const waiting = (code?: string) =>
      setSheet({
        title: '',
        actions: [],
        hideClose: true,
        extra: (
          <PairCard
            them={f.name}
            line="Waiting for them to accept"
            code={code}
            note={code ? `Check ${f.name} shows this code, then tap Accept there.` : 'Connecting…'}
            waiting
            actions={[
              {
                label: 'Cancel',
                onPress: () => {
                  ctrl.abort();
                  setSheet(null);
                },
              },
            ]}
          />
        ),
        onCancel: () => ctrl.abort(),
      });
    waiting();
    const timer = setTimeout(() => ctrl.abort(), 70_000);
    try {
      const peer = await pairWith(f, ctrl.signal, (code) => sheetOpen.current && waiting(code));
      setSheet(null);
      haptic.success();
      choose(paired(peer));
    } catch {
      if (ctrl.signal.aborted && !sheetOpen.current) return; // cancelled
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

  const scanned = (d: Device) => {
    haptic.success();
    writePrefs({ token: d.token, lan: d.base });
    choose(d);
  };

  const screen = !onboarded ? (
    <Onboarding
      onDone={() => {
        writePrefs({ onboarded: true });
        setOnboarded(true);
      }}
    />
  ) : current || (skipped && !scanning) ? (
    <MainScreen
      device={current ?? NO_DEVICE}
      devices={devices}
      nearby={nearby}
      saved={saved}
      onForget={forget}
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
        setScanning(true);
        setCurrent(null);
      }}
      onCable={cableHelp}
    />
  ) : scanning ? (
    <Scanner onConnect={scanned} onBack={() => setScanning(false)} />
  ) : (
    <ConnectScreen
      current={null}
      devices={devices}
      nearby={nearby}
      saved={saved}
      phones={!!Peer}
      outbox={outbox.length}
      visible={visible}
      onVisible={changeVisible}
      onPick={choose}
      onPair={pair}
      onForget={forget}
      onCable={cableHelp}
      onWifi={() => setScanning(true)}
      onSkip={() => {
        haptic.tap();
        setSkipped(true);
      }}
    />
  );

  return (
    // black shows around the screen when a sheet pushes it back
    <SafeAreaProvider style={{ backgroundColor: '#000' }}>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Behind style={{ backgroundColor: t.bg }}>{screen}</Behind>
      <Sheet content={sheet} onClose={() => setSheet(null)} />
      <Splash />
    </SafeAreaProvider>
  );
}
