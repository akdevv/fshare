import { useEffect, useState } from 'react';
import { Platform, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Directory, File } from 'expo-file-system';
import { Ionicons, MaterialCommunityIcons } from '@expo/vector-icons';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { Peer, type Found } from '../../modules/fshare-peer';
import { ENTER, EXIT } from '../components/motion';
import { Preferences } from '../components/preferences';
import { Sheet, type SheetContent } from '../components/sheet';
import { panelTitle, TransferList, TransferPanel } from '../components/transfers';
import { Cookie, Pop, Press, ThemeToggle } from '../components/ui';
import { useKeepAlive } from '../hooks/use-keep-alive';
import { useLink, type Link } from '../hooks/use-link';
import { baseName, LIVE, summary, useTransfers, type Job, type Remote } from '../hooks/use-transfers';
import { describe, linkName, type Device } from '../lib/device';
import { getSaveDir, label, pickSaveDir } from '../lib/downloads';
import { openFile } from '../lib/open';
import { readPrefs, type SavedPeer } from '../lib/prefs';
import { fmt, haptic, useStyles, type Theme } from '../theme';
import { About } from './about';
import { DevicesScreen } from './devices';

export function MainScreen({
  device,
  devices,
  nearby,
  saved,
  onForget,
  visible,
  onVisible,
  outbox,
  clearOutbox,
  onPick,
  onPair,
  onWifi,
  onCable,
}: {
  device: Device;
  devices: Device[];
  nearby: Found[];
  saved: SavedPeer[];
  onForget: (p: SavedPeer) => void;
  visible: boolean;
  onVisible: (v: boolean) => void;
  outbox: File[];
  clearOutbox: () => void;
  onPick: (d: Device) => void;
  onPair: (f: Found) => void;
  onWifi: () => void;
  onCable: () => void;
}) {
  const [st, t] = useStyles(styles);
  const insets = useSafeAreaInsets();
  const [saveDir, setSaveDir] = useState(getSaveDir);
  const [sheet, setSheet] = useState<SheetContent | null>(null);
  const [about, setAbout] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [picked, setPicked] = useState<Set<string> | null>(null); // select mode
  const [keepAlive, setKeepAlive] = useState(() => readPrefs().keepAlive !== false);
  const [declined, setDeclined] = useState(false); // no save folder chosen: laptop files wait on the laptop
  const [requested] = useState(() => new Set<string>());

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
              setSaveDir(d);
              resolve(d);
            },
          },
        ],
        onCancel: () => resolve(null),
      });
    });

  // what the laptop shares downloads by itself, once
  const fetchNew = (list: Remote[]) => {
    if (declined && !saveDir) return;
    const key = (r: Remote) => `${device.base}|${device.token}|${r.id}|${r.path}|${r.size}`;
    const fresh = list.filter((r) => !requested.has(key(r)));
    if (!fresh.length) return;
    fresh.forEach((r) => requested.add(key(r)));
    download(fresh).then((ok) => {
      if (ok) return;
      setDeclined(true); // picking a folder in Settings starts them
      fresh.forEach((r) => requested.delete(key(r)));
    });
  };

  const { link, name, outdated } = useLink(device, fetchNew);
  const transfers = useTransfers({ server: device, serverName: name, ensureSaveDir });
  const { jobs, setJobs, download, upload } = transfers;
  const live = jobs.filter((j) => LIVE.includes(j.state));
  const completed = jobs.filter((j) => !LIVE.includes(j.state));
  const online = link === 'online';
  const usb = device.via === 'usb';

  const liveTotal = live.reduce((n, j) => n + j.total, 0);
  const pct = liveTotal ? Math.floor((live.reduce((n, j) => n + j.done, 0) / liveTotal) * 100) : 0;
  useKeepAlive({
    enabled: keepAlive,
    busy: live.length > 0,
    title: live.length ? panelTitle(live) : `Connected to ${name}`,
    text: live.length ? `${pct}% · ${fmt(liveTotal)}` : 'Ready to send and receive',
    progress: pct,
  });

  useEffect(() => setDevicesOpen(false), [device.id]); // switched or paired: back to the transfers
  useEffect(() => {
    if (picked && !completed.length) setPicked(null);
  }, [completed.length]);

  // files shared into fshare from another app: confirm where they go first
  useEffect(() => {
    if (!online || !outbox.length) return;
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
    const sendTo = (d: Device) => () => {
      haptic.tap();
      clearOutbox();
      upload(files, d);
    };
    haptic.select();
    setSheet({
      title: files.length === 1 ? 'Send this file?' : `Send ${files.length} files?`,
      message: `${summary(names)}${size ? ` · ${fmt(size)}` : ''}`,
      actions: [
        { label: `Send to ${name}`, detail: describe(device), icon: 'arrow-up', onPress: sendTo(device) },
        ...devices
          .filter((d) => d.id !== device.id)
          .map((d) => ({
            label: `Send to ${d.name}`,
            detail: describe(d),
            icon: d.kind === 'laptop' ? ('laptop-outline' as const) : ('phone-portrait-outline' as const),
            onPress: sendTo(d),
          })),
      ],
      onCancel: clearOutbox,
    });
  }, [link, outbox]);

  const pickAndSend = async () => {
    const res = await File.pickFileAsync({ multipleFiles: true });
    if (!res.canceled) upload(res.result);
  };

  const openDevices = () => {
    haptic.tap();
    setDevicesOpen(true);
  };

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
            transfers.cancelAll();
            onWifi();
          },
        },
      ],
    });
  };

  const settings = () =>
    setSheet({
      title: 'Settings',
      subtitle: link === 'none' ? undefined : <ConnectionLine name={name} usb={usb} kind={device.kind} />,
      extra: (
        <View style={{ gap: 22 }}>
          <ThemeToggle />
          <Preferences onKeepAlive={setKeepAlive} />
        </View>
      ),
      actions: [
        ...(Platform.OS === 'android'
          ? [
              {
                label: 'Save folder',
                detail: saveDir ? label(saveDir) : 'Not set',
                icon: 'folder-outline' as const,
                onPress: async () => {
                  const d = await pickSaveDir();
                  if (!d) return;
                  setSaveDir(d);
                  setDeclined(false);
                },
              },
            ]
          : []),
        { label: 'About', detail: 'Version and connection', icon: 'information-circle-outline', onPress: () => setAbout(true) },
      ],
    });

  const open = async (job: Job) => {
    haptic.tap();
    if (job.file && (await openFile(job.file))) return;
    haptic.error();
    setSheet({ title: "Couldn't open this file", message: 'No app on this phone can open it, or it was moved or deleted.', actions: [] });
  };

  // select mode: long-press a finished transfer, then delete received files or clear them
  const select = (key?: string) => {
    haptic.select();
    setPicked(new Set(key ? [key] : []));
  };
  const toggle = (key: string) => {
    haptic.select();
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  const selectAll = () => {
    haptic.select();
    const all = completed.every((j) => picked?.has(j.key));
    setPicked(all ? new Set() : new Set(completed.map((j) => j.key)));
  };
  const removePicked = () => {
    setJobs((js) => js.filter((j) => !picked?.has(j.key)));
    setPicked(null);
  };
  const onPhone = completed.filter((j) => picked?.has(j.key) && j.dir === 'down' && j.file);
  const deletePicked = () => {
    haptic.reject();
    setSheet({
      title: onPhone.length === 1 ? 'Delete this file?' : `Delete ${onPhone.length} files?`,
      message: `${summary(onPhone.map((j) => baseName(j.name)))}. They're removed from this phone; files on other devices stay.`,
      actions: [
        {
          label: 'Delete',
          icon: 'trash-outline',
          destructive: true,
          onPress: () => {
            for (const j of onPhone)
              try {
                j.file!.delete();
              } catch {}
            removePicked();
            haptic.success();
          },
        },
      ],
    });
  };

  return (
    <SafeAreaView style={st.root} edges={['top', 'left', 'right']}>
      <ScrollView contentContainerStyle={st.content} contentInsetAdjustmentBehavior="automatic" showsVerticalScrollIndicator={false}>
        <Header link={link} device={device} name={name} outdated={outdated} onDevices={openDevices} onSettings={settings} />

        {live.length > 0 && (
          <TransferPanel
            live={live}
            speed={transfers.speed}
            onPause={transfers.pause}
            onResume={transfers.resume}
            onCancel={transfers.cancel}
            onPauseAll={transfers.pauseAll}
            onResumeAll={transfers.resumeAll}
            onCancelAll={transfers.cancelAll}
          />
        )}

        {!jobs.length && (
          <Animated.View style={st.empty} entering={ENTER} exiting={EXIT}>
            <Cookie size={76} color={t.surface2}>
              <Ionicons name="swap-vertical" size={26} color={t.dim} />
            </Cookie>
            <Text style={st.emptyTitle}>Nothing here yet</Text>
            <Text style={[st.meta, { textAlign: 'center', lineHeight: 19 }]}>
              {link === 'none' ? 'Connect a device to start sharing.' : `Files from ${name} land here.`}
            </Text>
          </Animated.View>
        )}

        {completed.length > 0 && (
          <TransferList
            jobs={completed}
            picked={picked}
            onSelect={select}
            onSelectAll={selectAll}
            onClear={transfers.clearFinished}
            onToggle={toggle}
            onOpen={open}
          />
        )}
      </ScrollView>

      <View style={[st.dock, { paddingBottom: insets.bottom + 10 }]} pointerEvents="box-none">
        <View style={st.fade} pointerEvents="none" />
        {picked ? (
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
              {picked.size ? `${picked.size} selected` : 'Select files'}
            </Text>
            <Press
              style={st.barBtn}
              disabled={!picked.size}
              onPress={() => {
                haptic.select();
                removePicked();
              }}
              accessibilityRole="button"
              accessibilityLabel="Clear from list"
            >
              <Ionicons name="list-outline" size={16} color={t.text} />
              <Text style={st.barBtnText}>Clear</Text>
            </Press>
            <Press
              style={[st.barBtn, { backgroundColor: t.redSoft }]}
              disabled={!onPhone.length}
              onPress={deletePicked}
              accessibilityRole="button"
              accessibilityLabel="Delete from phone"
            >
              <Ionicons name="trash-outline" size={16} color={t.red} />
              <Text style={[st.barBtnText, { color: t.red }]}>Delete</Text>
            </Press>
          </Animated.View>
        ) : (
          <Animated.View key="send" entering={ENTER} style={st.dockRow}>
            <Press
              grow
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
            <Press
              style={[st.devicesBtn, link === 'none' && { backgroundColor: t.accentSoft, borderColor: 'transparent' }]}
              onPress={openDevices}
              accessibilityRole="button"
              accessibilityLabel={link === 'none' ? 'Connect a device' : 'Devices'}
            >
              <MaterialCommunityIcons name="devices" size={22} color={link === 'none' ? t.onAccentSoft : t.text} />
            </Press>
          </Animated.View>
        )}
      </View>

      <Sheet content={sheet} onClose={() => setSheet(null)} />
      <DevicesScreen
        open={devicesOpen}
        current={{ ...device, name }}
        devices={devices}
        nearby={nearby}
        saved={saved}
        phones={!!Peer}
        visible={visible}
        onVisible={onVisible}
        onPick={(d) => {
          setDevicesOpen(false);
          onPick(d);
        }}
        onPair={onPair}
        onForget={onForget}
        onCable={onCable}
        onWifi={() => {
          setDevicesOpen(false);
          wifi();
        }}
        onBack={() => setDevicesOpen(false)}
      />
      <About
        open={about}
        onClose={() => setAbout(false)}
        name={name}
        usb={usb}
        host={device.base}
        outdated={outdated && device.kind === 'laptop'}
        kind={device.kind}
      />
    </SafeAreaView>
  );
}

// The device card: who you're connected to and how. Tapping it opens Devices.
function Header({
  link,
  device,
  name,
  outdated,
  onDevices,
  onSettings,
}: {
  link: Link;
  device: Device;
  name: string;
  outdated: boolean;
  onDevices: () => void;
  onSettings: () => void;
}) {
  const [st, t] = useStyles(styles);
  const online = link === 'online';
  // one quiet chip: grey normally, red only while reconnecting
  const chip =
    link === 'none'
      ? { icon: 'radio-outline' as const, label: 'No device', bg: t.surface2, fg: t.dim, spin: false }
      : online
        ? {
            icon: device.via === 'usb' ? ('flash' as const) : ('wifi' as const),
            label: linkName(device.via),
            bg: t.surface2,
            fg: t.dim,
            spin: false,
          }
        : link === 'offline'
          ? { icon: 'sync' as const, label: 'Reconnecting…', bg: t.redSoft, fg: t.red, spin: true }
          : { icon: 'sync' as const, label: 'Connecting…', bg: t.surface2, fg: t.dim, spin: true };
  return (
    <View style={st.device}>
      <Press
        grow
        style={st.deviceTap}
        highlight={t.surface2}
        onPress={onDevices}
        accessibilityRole="button"
        accessibilityLabel={`${name}, ${online ? `connected over ${chip.label}` : chip.label}`}
        accessibilityHint="Switch device"
      >
        <Pop id={device.kind}>
          <Cookie size={58} color={t.accentSoft}>
            <Ionicons
              name={link === 'none' ? 'swap-horizontal' : device.kind === 'laptop' ? 'laptop-outline' : 'phone-portrait-outline'}
              size={25}
              color={t.onAccentSoft}
            />
          </Cookie>
        </Pop>
        <View style={{ flex: 1, gap: 5 }}>
          <Pop id={name} fade>
            <Text style={st.deviceName} numberOfLines={1}>
              {name}
            </Text>
          </Pop>
          <Pop id={chip.label} fade>
            <Animated.View
              style={[st.chip, { backgroundColor: chip.bg, transitionProperty: 'backgroundColor', transitionDuration: 200 }]}
              accessible
              accessibilityLabel={online ? `Connected over ${chip.label}` : chip.label}
            >
              <Animated.View style={chip.spin && SPIN}>
                <Ionicons name={chip.icon} size={12} color={chip.fg} />
              </Animated.View>
              <Text style={[st.chipText, { color: chip.fg }]} numberOfLines={1}>
                {chip.label}
              </Text>
            </Animated.View>
          </Pop>
          {outdated && device.kind === 'laptop' && (
            <Text style={[st.meta, { color: t.amber, fontSize: 12 }]}>Update fshare on your laptop to connect</Text>
          )}
        </View>
      </Press>
      <Press style={st.settings} onPress={onSettings} hitSlop={4} accessibilityRole="button" accessibilityLabel="Settings">
        <Ionicons name="ellipsis-horizontal" size={20} color={t.text} />
      </Press>
    </View>
  );
}

const SPIN = {
  animationName: { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } },
  animationDuration: '1.4s',
  animationIterationCount: 'infinite',
  animationTimingFunction: 'linear',
} as const;

// "⚡ USB cable · Ashish's MacBook Air", under the Settings title
function ConnectionLine({ name, usb, kind }: { name: string; usb: boolean; kind: Device['kind'] }) {
  const [st, t] = useStyles(styles);
  const via = usb ? 'USB cable' : 'Wi-Fi';
  return (
    <View style={st.connLine} accessible accessibilityLabel={`Connected to ${name} over ${via}`}>
      <Ionicons name={kind === 'phone' ? 'phone-portrait-outline' : usb ? 'flash' : 'wifi'} size={14} color={t.text} />
      <Text style={st.connVia}>{via}</Text>
      <Text style={st.connDot}>·</Text>
      <Text style={[st.meta, { flexShrink: 1, fontSize: 14 }]} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    content: { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 120, gap: 12 },
    meta: { color: t.dim, fontSize: 13 },

    device: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      padding: 14,
      borderRadius: 24,
      borderCurve: 'continuous',
      backgroundColor: t.surface,
    },
    deviceTap: { flexDirection: 'row', alignItems: 'center', gap: 14, margin: -8, padding: 8, borderRadius: 18, borderCurve: 'continuous' },
    deviceName: { color: t.text, fontSize: 18, fontWeight: '700', letterSpacing: -0.3 },
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
    settings: {
      width: 38,
      height: 38,
      padding: 3,
      borderRadius: 19,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
    },
    connLine: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    connVia: { color: t.text, fontSize: 14, fontWeight: '600' },
    connDot: { color: t.faint, fontSize: 14 },

    empty: { alignItems: 'center', gap: 8, paddingVertical: 56, paddingHorizontal: 28 },
    emptyTitle: { color: t.text, fontSize: 17, fontWeight: '700', marginTop: 10 },

    dock: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 4, backgroundColor: t.bg },
    fade: {
      position: 'absolute',
      left: 0,
      right: 0,
      top: -28,
      height: 28,
      experimental_backgroundImage: `linear-gradient(to bottom, ${t.bg}00, ${t.bg})`,
    },
    dockRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    send: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      height: 60,
      borderRadius: 30,
      backgroundColor: t.accent, // under the gradient, in case it can't draw
      // flat with a hint of depth: a faint top-to-bottom shade, a rim, light on the top inner edge
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
    devicesBtn: {
      width: 60,
      height: 60,
      borderRadius: 30,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.line,
      boxShadow:
        t.scheme === 'dark'
          ? 'inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.2), 0 1px 2px rgba(0,0,0,0.3)'
          : 'inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -1px 0 rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.08)',
    },
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
  });
