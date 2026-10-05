import { Image, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, ReduceMotion } from 'react-native-reanimated';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { haptic, useStyles, type Theme } from './theme';
import { getSaveDir, label } from './downloads';
import { myName } from './modules/fshare-peer';

type Props = {
  open: boolean;
  onClose: () => void;
  laptop: string;
  usb: boolean;
  host: string;
  outdated: boolean;
  kind: 'laptop' | 'phone';
};

type Row = { k: string; v: string; mono?: boolean; warn?: boolean };

// Full-screen About: the app, who you're connected to, and this phone. Nothing else.
export function About({ open, onClose, laptop, usb, host, outdated, kind }: Props) {
  const [s, t] = useStyles(styles);
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const build = Platform.OS === 'ios' ? Constants.expoConfig?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode;
  const connection: Row[] = [
    { k: kind === 'laptop' ? 'Laptop' : 'Phone', v: laptop },
    { k: 'Connection', v: usb ? 'USB cable' : 'Wi-Fi' },
    ...(usb ? [] : [{ k: 'Address', v: host.replace(/^http:\/\//, ''), mono: true }]),
    ...(outdated ? [{ k: 'Laptop app', v: 'Restart fshare to update', warn: true }] : []),
  ];
  const phone: Row[] = [
    { k: 'Name', v: myName },
    { k: 'Saves to', v: Platform.OS === 'ios' ? 'Files › fshare' : label(getSaveDir()) },
  ];
  const close = () => {
    haptic.tap();
    onClose();
  };

  const group = (title: string, rows: Row[], i: number) => (
    <Animated.View entering={rise(i)} style={{ gap: 8 }}>
      <Text style={s.label}>{title}</Text>
      <View style={s.group}>
        {rows.map((r, j) => (
          <View key={r.k} style={s.row}>
            {j > 0 && <View style={s.sep} />}
            <Text style={s.key}>{r.k}</Text>
            <Text style={[s.value, r.mono && s.addr, r.warn && { color: t.amber }]} numberOfLines={1} selectable>
              {r.mono ? (
                <>
                  {r.v.replace(/:\d+$/, '')}
                  <Text style={{ color: t.faint }}>{r.v.match(/:\d+$/)?.[0]}</Text>
                </>
              ) : (
                r.v
              )}
            </Text>
          </View>
        ))}
      </View>
    </Animated.View>
  );

  return (
    <Modal
      visible={open}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      {/* a full-screen modal is its own native window: it needs its own safe-area provider */}
      <SafeAreaProvider>
        <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
        <SafeAreaView style={s.root}>
          <View style={s.bar}>
            <Pressable
              onPress={close}
              hitSlop={12}
              style={({ pressed }) => [s.back, pressed && { opacity: 0.6 }]}
              accessibilityRole="button"
              accessibilityLabel="Back"
            >
              <Ionicons name="chevron-back" size={20} color={t.text} />
            </Pressable>
            <Text style={s.barTitle}>About</Text>
            <View style={{ width: 40 }} />
          </View>

          <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
            <Animated.View entering={rise(0)} style={s.hero}>
              <Image source={require('./assets/icon.png')} style={s.icon} accessibilityIgnoresInvertColors />
              <Text style={s.name}>fshare</Text>
              <Text style={s.tagline}>Send files between your phone, laptop and other phones</Text>
              <View style={s.version}>
                <Text style={s.versionText}>
                  Version {version}
                  {build ? ` (${build})` : ''}
                </Text>
              </View>
            </Animated.View>

            {group('Connected to', connection, 1)}
            {group('This phone', phone, 2)}

            <Animated.View entering={rise(3)} style={s.note}>
              <Ionicons name="lock-closed-outline" size={15} color={t.dim} />
              <Text style={s.noteText}>
                Files go straight between your devices over the cable or your Wi-Fi. Nothing passes through a server.
              </Text>
            </Animated.View>
          </ScrollView>
        </SafeAreaView>
      </SafeAreaProvider>
    </Modal>
  );
}

const rise = (i: number) =>
  FadeInDown.delay(60 + i * 60)
    .duration(400)
    .easing(Easing.bezier(0.23, 1, 0.32, 1))
    .withInitialValues({ transform: [{ translateY: 8 }] })
    .reduceMotion(ReduceMotion.System);

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 4,
    },
    barTitle: { color: t.text, fontSize: 17, fontWeight: '700' },
    back: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' },
    body: { paddingHorizontal: 16, paddingTop: 24, paddingBottom: 48, gap: 24 },

    hero: { alignItems: 'center', paddingBottom: 8 },
    icon: { width: 96, height: 96, borderRadius: 24, borderCurve: 'continuous', marginBottom: 18 },
    name: { color: t.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.9 },
    tagline: { color: t.dim, fontSize: 15, marginTop: 4 },
    version: { marginTop: 14, height: 26, paddingHorizontal: 11, borderRadius: 13, backgroundColor: t.surface2, justifyContent: 'center' },
    versionText: { color: t.dim, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },

    label: { color: t.dim, fontSize: 14, fontWeight: '600', paddingHorizontal: 4 },
    group: { backgroundColor: t.surface, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 16, minHeight: 52, paddingHorizontal: 16 },
    sep: { position: 'absolute', top: 0, left: 16, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.line },
    key: { color: t.dim, fontSize: 15 },
    value: { color: t.text, fontSize: 15, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
    // same face as the rest; even-width digits keep addresses tidy
    addr: { fontWeight: '600', fontVariant: ['tabular-nums'], letterSpacing: 0.2 },

    note: { flexDirection: 'row', gap: 10, paddingHorizontal: 4 },
    noteText: { flex: 1, color: t.dim, fontSize: 13, lineHeight: 19 },
  });
