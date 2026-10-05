import { useEffect, useState } from 'react';
import { BackHandler, Image, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeInDown, ReduceMotion, SlideInRight, SlideOutRight } from 'react-native-reanimated';
import Constants from 'expo-constants';
import { StatusBar } from 'expo-status-bar';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { font, haptic, useStyles, type Theme } from './theme';
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

type Icon = keyof typeof Ionicons.glyphMap;
type Row = { icon: Icon; k: string; v: string; addr?: boolean; path?: boolean; warn?: boolean };

const BAR = 52;

// Full-screen About: the app, who you're connected to, and this phone. Nothing else.
// A layer in the app's own window (not a Modal), so it's edge to edge with the right insets on
// Android too; slides in from the right like a pushed screen, and Back closes it.
export function About(props: Props) {
  if (!props.open) return null;
  return (
    <Animated.View
      entering={SlideInRight.duration(340)
        .easing(Easing.bezier(0.32, 0.72, 0, 1))
        .reduceMotion(ReduceMotion.System)}
      exiting={SlideOutRight.duration(260)
        .easing(Easing.bezier(0.32, 0.72, 0, 1))
        .reduceMotion(ReduceMotion.System)}
      style={StyleSheet.absoluteFill}
    >
      <Page {...props} />
    </Animated.View>
  );
}

function Page({ onClose, laptop, usb, host, outdated, kind }: Props) {
  const [s, t] = useStyles(styles);
  const insets = useSafeAreaInsets();
  const [scrolled, setScrolled] = useState(false);
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const build = Platform.OS === 'ios' ? Constants.expoConfig?.ios?.buildNumber : Constants.expoConfig?.android?.versionCode;
  const connection: Row[] = [
    { icon: kind === 'laptop' ? 'laptop-outline' : 'phone-portrait-outline', k: kind === 'laptop' ? 'Laptop' : 'Phone', v: laptop },
    { icon: usb ? 'flash-outline' : 'wifi-outline', k: 'Connection', v: usb ? 'USB cable' : 'Wi-Fi' },
    ...(usb ? [] : [{ icon: 'globe-outline' as Icon, k: 'Address', v: host.replace(/^http:\/\//, ''), addr: true }]),
    ...(outdated ? [{ icon: 'refresh-outline' as Icon, k: 'Laptop app', v: 'Restart fshare to update', warn: true }] : []),
  ];
  const phone: Row[] = [
    { icon: 'phone-portrait-outline', k: 'Name', v: myName },
    { icon: 'folder-outline', k: 'Saves to', v: Platform.OS === 'ios' ? 'Files/fshare' : label(getSaveDir()), path: true },
  ];
  const close = () => {
    haptic.tap();
    onClose();
  };
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const group = (title: string, rows: Row[], i: number) => (
    <Animated.View entering={rise(i)} style={{ gap: 8 }}>
      <Text style={s.label}>{title}</Text>
      <View style={s.group}>
        {rows.map((r, j) => (
          <View key={r.k} style={s.row}>
            {j > 0 && <View style={s.sep} />}
            <View style={s.icon}>
              <Ionicons name={r.icon} size={16} color={r.warn ? t.amber : t.dim} />
            </View>
            <Text style={s.key}>{r.k}</Text>
            {r.addr ? (
              <Text style={s.addr} numberOfLines={1} selectable>
                {r.v.replace(/:\d+$/, '')}
                <Text style={{ color: t.faint }}>{r.v.match(/:\d+$/)?.[0]}</Text>
              </Text>
            ) : r.path ? (
              // "Download/fshare": the parent folders quiet, the folder itself in full
              <Text style={s.value} numberOfLines={1} ellipsizeMode="head" selectable>
                {r.v.split('/').map((part, k, all) =>
                  k < all.length - 1 ? (
                    <Text key={k}>
                      {part}
                      <Text style={{ color: t.faint }}> / </Text>
                    </Text>
                  ) : (
                    <Text key={k} style={{ color: t.text }}>
                      {part}
                    </Text>
                  ),
                )}
              </Text>
            ) : (
              <Text style={[s.value, r.warn && { color: t.amber }]} numberOfLines={1} selectable>
                {r.v}
              </Text>
            )}
          </View>
        ))}
      </View>
    </Animated.View>
  );

  return (
    <View style={s.root}>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <ScrollView
        contentContainerStyle={[s.body, { paddingTop: insets.top + BAR + 20, paddingBottom: insets.bottom + 40 }]}
        showsVerticalScrollIndicator={false}
        scrollEventThrottle={32}
        onScroll={(e) => setScrolled(e.nativeEvent.contentOffset.y > 4)}
      >
        <Animated.View entering={rise(0)} style={s.hero}>
          <Image source={require('./assets/icon.png')} style={s.appIcon} accessibilityIgnoresInvertColors />
          <Text style={s.name}>fshare</Text>
          <View style={s.version}>
            <Text style={s.versionText}>
              v{version}
              {build ? <Text style={{ color: t.faint }}> · {build}</Text> : null}
            </Text>
          </View>
        </Animated.View>
        {group('Connected to', connection, 1)}
        {group('This phone', phone, 2)}
      </ScrollView>

      {/* the bar is the page's own colour; a hairline appears once content slides under it */}
      <View style={[s.top, { paddingTop: insets.top, height: insets.top + BAR }, scrolled && s.topLine]}>
        <Pressable
          onPress={close}
          hitSlop={12}
          style={({ pressed }) => [s.back, pressed && { opacity: 0.6 }]}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={20} color={t.text} />
        </Pressable>
        <Text style={s.barTitle} accessibilityRole="header">
          About
        </Text>
        <View style={{ width: 40 }} />
      </View>
      {/* content fades out above the gesture bar instead of meeting a hard edge */}
      <View
        pointerEvents="none"
        style={[s.bottom, { height: insets.bottom + 28, experimental_backgroundImage: `linear-gradient(to bottom, ${t.bg}00, ${t.bg})` }]}
      />
    </View>
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
    top: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      backgroundColor: t.bg,
    },
    topLine: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: t.line },
    bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
    barTitle: { color: t.text, fontSize: 17, fontWeight: '600' },
    back: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' },
    body: { paddingHorizontal: 16, gap: 28 },

    hero: { alignItems: 'center', gap: 10 },
    appIcon: { width: 88, height: 88, borderRadius: 22, borderCurve: 'continuous', marginBottom: 6 },
    name: { color: t.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.6 },
    version: { height: 28, paddingHorizontal: 12, borderRadius: 14, backgroundColor: t.surface, justifyContent: 'center' },
    versionText: { color: t.dim, fontSize: 12.5, fontFamily: font.mono },

    label: { color: t.dim, fontSize: 13, fontWeight: '600', paddingHorizontal: 4, textTransform: 'uppercase', letterSpacing: 0.6 },
    group: { backgroundColor: t.surface, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 54, paddingHorizontal: 14 },
    sep: { position: 'absolute', top: 0, left: 54, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: t.line },
    icon: {
      width: 28,
      height: 28,
      borderRadius: 8,
      borderCurve: 'continuous',
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    key: { color: t.text, fontSize: 15 },
    value: { flex: 1, color: t.dim, fontSize: 15, textAlign: 'right' },
    addr: { flex: 1, color: t.text, fontSize: 14, fontFamily: font.mono, textAlign: 'right' },
  });
