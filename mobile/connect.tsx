// The one place to connect: your devices, phones nearby, and the other ways in. Full screen.
// Opened from the main screen (Back), or shown on launch when nothing is connected (Skip).
import { useEffect, useState } from 'react';
import { BackHandler, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  SlideInRight,
  SlideOutRight,
  useReducedMotion,
} from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { haptic, useStyles, type Theme } from './theme';
import { Cookie, EASE_OUT, Press, Toggle } from './ui';
import { ConnectOptions, ForgetButton, NO_DEVICE, type Device } from './session';
import type { Found } from './modules/fshare-peer';
import { me } from './identity';
import type { SavedPeer } from './prefs';

type Props = {
  current: Device | null; // what the main screen is on; null when nothing is
  devices: Device[]; // reachable right now
  nearby: Found[]; // phones on this Wi-Fi not yet paired
  saved: SavedPeer[]; // paired phones
  phones: boolean; // this app can connect to phones (the installed app, not Expo Go)
  outbox?: number;
  visible: boolean;
  onVisible: (v: boolean) => void;
  onPick: (d: Device) => void;
  onPair: (f: Found) => void;
  onForget: (p: SavedPeer) => void;
  onCable?: () => void;
  onWifi: () => void;
  onBack?: () => void; // opened from the main screen
  onSkip?: () => void; // the launch screen
};

const EASE = Easing.bezier(0.32, 0.72, 0, 1);
// paired before 1.0.8, when phones swapped their keys in the clear: forget it and pair again
const REPAIR = 'Forget and pair again to secure';

// pushed from the main screen: slides in from the right, Back (or the back gesture) closes it
export function DevicesScreen(props: Props & { open: boolean }) {
  if (!props.open) return null;
  return (
    <Animated.View
      entering={SlideInRight.duration(340).easing(EASE).reduceMotion(ReduceMotion.System)}
      exiting={SlideOutRight.duration(260).easing(EASE).reduceMotion(ReduceMotion.System)}
      style={StyleSheet.absoluteFill}
    >
      <ConnectScreen {...props} />
    </Animated.View>
  );
}

export function ConnectScreen({
  current,
  devices,
  nearby,
  saved,
  phones,
  outbox = 0,
  visible,
  onVisible,
  onPick,
  onPair,
  onForget,
  onCable,
  onWifi,
  onBack,
  onSkip,
}: Props) {
  const [st, t] = useStyles(styles);
  const [gone, setGone] = useState<string[]>([]); // forgotten here, before the parent catches up
  const [more, setMore] = useState(false); // "Other ways to connect" open
  const [on, setOn] = useState(visible);

  useEffect(() => {
    if (!onBack) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onBack();
      return true;
    });
    return () => sub.remove();
  }, [onBack]);

  const connected = current && current.id !== NO_DEVICE.id ? current : null;
  const pairedOf = (d: Device) => saved.find((p) => `phone-${p.id}` === d.id && !gone.includes(p.id));
  // your devices: everything reachable (the one you're on first), then paired phones that aren't around
  const reachable = [...(connected ? [connected] : []), ...devices.filter((d) => d.id !== connected?.id)].filter(
    (d) => !d.id.startsWith('phone-') || pairedOf(d),
  );
  const away = saved.filter((p) => !gone.includes(p.id) && !devices.some((d) => d.id === `phone-${p.id}`));
  const forget = (p: SavedPeer) => {
    setGone((g) => [...g, p.id]);
    onForget(p);
  };
  const via = (d: Device) => `${d.kind === 'laptop' ? 'Laptop' : 'Phone'} · ${d.via === 'usb' ? 'USB cable' : 'Wi-Fi'}`;

  return (
    <SafeAreaView style={st.root} edges={['top', 'left', 'right']}>
      <View style={st.bar}>
        {onBack && (
          <Press style={st.round} onPress={onBack} hitSlop={8} accessibilityRole="button" accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={20} color={t.text} />
          </Press>
        )}
        <Text style={[st.title, !onBack && { paddingLeft: 4 }]} accessibilityRole="header" numberOfLines={1}>
          {connected ? 'Devices' : 'Connect a device'}
        </Text>
        {onSkip && (
          <Press style={st.skip} onPress={onSkip} hitSlop={8} accessibilityRole="button" accessibilityLabel="Skip for now">
            <Text style={st.skipText}>Skip</Text>
          </Press>
        )}
      </View>

      <ScrollView contentContainerStyle={st.body} showsVerticalScrollIndicator={false}>
        {(!connected || outbox > 0) && (
          <View style={{ gap: 10, paddingHorizontal: 4 }}>
            {!connected && (
              <Text style={st.sub}>{phones ? 'Pick a phone nearby, or connect your laptop.' : 'Connect your laptop to start.'}</Text>
            )}
            {outbox > 0 && (
              <View style={st.outbox}>
                <Ionicons name="arrow-up-circle" size={16} color={t.onAccentSoft} />
                <Text style={st.outboxText}>
                  {outbox} {outbox === 1 ? 'file' : 'files'} waiting to send
                </Text>
              </View>
            )}
          </View>
        )}

        {(reachable.length > 0 || away.length > 0) && (
          <Section title="Your devices">
            {reachable.map((d, i) => {
              const now = d.id === connected?.id;
              const p = pairedOf(d);
              return (
                <Animated.View key={d.id} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(240)}>
                  {i > 0 && <View style={st.sep} />}
                  <Press
                    style={st.row}
                    highlight={now ? undefined : t.surface2}
                    onPress={now ? undefined : () => onPick(d)}
                    accessibilityRole={now ? undefined : 'button'}
                    accessibilityLabel={`${d.name}, ${via(d)}${now ? ', connected' : ''}`}
                  >
                    <View style={[st.icon, now && { backgroundColor: t.accentSoft }]}>
                      <Ionicons
                        name={d.kind === 'laptop' ? 'laptop-outline' : 'phone-portrait-outline'}
                        size={19}
                        color={now ? t.onAccentSoft : t.text}
                      />
                    </View>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={st.name} numberOfLines={1}>
                        {d.name}
                      </Text>
                      <Text style={[st.meta, p && !p.e2e && st.warn]} numberOfLines={1}>
                        {p && !p.e2e ? REPAIR : via(d)}
                      </Text>
                    </View>
                    {p && <ForgetButton name={p.name} onForget={() => forget(p)} bg={t.surface2} />}
                    {now ? (
                      <View style={st.badge}>
                        <Ionicons name="checkmark" size={13} color={t.onAccent} />
                      </View>
                    ) : (
                      <View style={st.pill}>
                        <Text style={st.pillText}>Switch</Text>
                      </View>
                    )}
                  </Press>
                </Animated.View>
              );
            })}
            {away.map((p, i) => (
              <Animated.View key={p.id} exiting={FadeOut.duration(160)} layout={LinearTransition.duration(240)}>
                {(i > 0 || reachable.length > 0) && <View style={st.sep} />}
                <View style={st.row} accessible accessibilityLabel={`${p.name}, not nearby`}>
                  <View style={st.icon}>
                    <Ionicons name="phone-portrait-outline" size={19} color={t.faint} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text style={[st.name, { color: t.dim }]} numberOfLines={1}>
                      {p.name}
                    </Text>
                    <Text style={[st.meta, !p.e2e && st.warn]} numberOfLines={1}>
                      {p.e2e ? 'Not nearby' : REPAIR}
                    </Text>
                  </View>
                  <ForgetButton name={p.name} onForget={() => forget(p)} bg={t.surface2} />
                </View>
              </Animated.View>
            ))}
          </Section>
        )}

        {phones && (
          // compact: one line, the switch says the rest
          <Press
            style={st.visible}
            highlight={t.surface2}
            onPress={() => {
              haptic.toggle(!on);
              setOn(!on);
              onVisible(!on);
            }}
            accessibilityRole="switch"
            accessibilityState={{ checked: on }}
            accessibilityLabel="Visible to nearby phones"
          >
            <Ionicons name={on ? 'eye-outline' : 'eye-off-outline'} size={17} color={t.dim} />
            <Text style={st.visibleText} numberOfLines={1}>
              {on ? (
                <>
                  Visible as <Text style={{ color: t.text }}>{me.name}</Text>
                </>
              ) : (
                'Hidden from nearby phones'
              )}
            </Text>
            <Toggle on={on} />
          </Press>
        )}

        {phones && (
          <Section title="Nearby">
            {nearby.length === 0 ? (
              <Searching />
            ) : (
              nearby.map((f, i) => (
                <Animated.View
                  key={f.name}
                  entering={FadeIn.duration(220)}
                  exiting={FadeOut.duration(160)}
                  layout={LinearTransition.duration(240)}
                >
                  {i > 0 && <View style={st.sep} />}
                  <Press
                    style={st.row}
                    highlight={t.surface2}
                    onPress={() => onPair(f)}
                    accessibilityRole="button"
                    accessibilityLabel={`Connect to ${f.name}`}
                  >
                    <Cookie size={40} color={t.accentSoft}>
                      <Ionicons name="phone-portrait-outline" size={17} color={t.onAccentSoft} />
                    </Cookie>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={st.name} numberOfLines={1}>
                        {f.name}
                      </Text>
                      <Text style={st.meta}>On this Wi-Fi</Text>
                    </View>
                    <View style={[st.pill, { backgroundColor: t.accent }]}>
                      <Text style={[st.pillText, { color: t.onAccent }]}>Connect</Text>
                    </View>
                  </Press>
                </Animated.View>
              ))
            )}
          </Section>
        )}

        {/* the less common ways in, folded away until asked for */}
        <View style={{ gap: 8 }}>
          <Press
            style={st.fold}
            highlight={t.surface2}
            onPress={() => {
              haptic.select();
              setMore((m) => !m);
            }}
            accessibilityRole="button"
            accessibilityState={{ expanded: more }}
            accessibilityLabel="Other ways to connect"
          >
            <Text style={st.foldText}>Other ways to connect</Text>
            <Animated.View
              style={{
                transform: [{ rotate: more ? '180deg' : '0deg' }],
                transitionProperty: 'transform',
                transitionDuration: 220,
                transitionTimingFunction: EASE_OUT,
              }}
            >
              <Ionicons name="chevron-down" size={16} color={t.dim} />
            </Animated.View>
          </Press>
          {more && (
            <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(140)}>
              <ConnectOptions onCable={phones ? onCable : undefined} onWifi={onWifi} />
            </Animated.View>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const [st] = useStyles(styles);
  return (
    <View style={{ gap: 8 }}>
      <View style={st.sectionHead}>
        <Text style={st.label}>{title}</Text>
      </View>
      <View style={st.group}>{children}</View>
    </View>
  );
}

// nothing nearby yet: the app's searching mark, small, with a line on what to do
function Searching() {
  const [st, t] = useStyles(styles);
  const reduced = useReducedMotion();
  return (
    <View style={st.searching}>
      <View style={{ width: 56, height: 56, alignItems: 'center', justifyContent: 'center' }}>
        {!reduced &&
          [0, 1.4].map((delay) => (
            <Animated.View
              key={delay}
              pointerEvents="none"
              style={{
                position: 'absolute',
                opacity: 0,
                animationName: { from: { opacity: 0.5, transform: [{ scale: 1 }] }, to: { opacity: 0, transform: [{ scale: 1.7 }] } },
                animationDuration: '2.8s',
                animationDelay: `${delay}s`,
                animationIterationCount: 'infinite',
                animationTimingFunction: EASE_OUT,
              }}
            >
              <Cookie size={56} color={t.accent} outline />
            </Animated.View>
          ))}
        <Cookie size={56} color={t.accentSoft} spin={24}>
          <Ionicons name="swap-horizontal" size={22} color={t.onAccentSoft} />
        </Cookie>
      </View>
      <View style={{ alignItems: 'center', gap: 3 }}>
        <Text style={st.name}>Looking for phones</Text>
        <Text style={[st.meta, { textAlign: 'center' }]}>Open fshare on a phone on this Wi-Fi</Text>
      </View>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    bar: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16 },
    round: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' },
    skip: {
      height: 34,
      paddingHorizontal: 16,
      borderRadius: 17,
      justifyContent: 'center',
      backgroundColor: t.surface2,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
    },
    skipText: { color: t.dim, fontSize: 14, fontWeight: '600' },
    body: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 48, gap: 22 },
    title: { flex: 1, color: t.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.4 },
    sub: { color: t.dim, fontSize: 15, lineHeight: 21 },
    outbox: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      height: 30,
      paddingHorizontal: 12,
      borderRadius: 15,
      backgroundColor: t.accentSoft,
    },
    outboxText: { color: t.onAccentSoft, fontSize: 13, fontWeight: '600' },

    sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
    label: { color: t.text, fontSize: 15, fontWeight: '600' },
    group: { backgroundColor: t.surface, borderRadius: 20, borderCurve: 'continuous', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 14, paddingVertical: 10 },
    sep: { height: StyleSheet.hairlineWidth, backgroundColor: t.line, marginLeft: 66 },
    icon: {
      width: 40,
      height: 40,
      borderRadius: 13,
      borderCurve: 'continuous',
      backgroundColor: t.surface2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    name: { color: t.text, fontSize: 16, fontWeight: '600' },
    meta: { color: t.dim, fontSize: 13 },
    warn: { color: t.amber },
    badge: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    pill: { height: 32, paddingHorizontal: 14, borderRadius: 16, backgroundColor: t.surface2, justifyContent: 'center' },
    pillText: { color: t.text, fontSize: 13, fontWeight: '700' },
    searching: { alignItems: 'center', gap: 14, paddingVertical: 24, paddingHorizontal: 16 },

    fold: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      height: 52,
      paddingHorizontal: 16,
      borderRadius: 16,
      borderCurve: 'continuous',
    },
    foldText: { color: t.dim, fontSize: 15, fontWeight: '600' },
    visible: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      height: 52,
      paddingLeft: 14,
      paddingRight: 10,
      borderRadius: 16,
      borderCurve: 'continuous',
      backgroundColor: t.surface,
    },
    visibleText: { flex: 1, color: t.dim, fontSize: 14 },
  });
