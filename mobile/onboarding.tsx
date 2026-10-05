// First launch only: what fshare does, how to connect, and on Android
// where files go. Each page is an illustration in the app's own style, then a title and one paragraph.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInDown,
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedProps,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Path, Rect } from 'react-native-svg';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getSaveDir, pickSaveDir } from './downloads';
import { font, haptic, useStyles, useTheme, type Theme } from './theme';
import { Cookie, Press } from './ui';

type Step = { key: string; title: string; body: string; art: ReactNode; extra?: ReactNode };

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [st, t] = useStyles(styles);
  const { width } = useWindowDimensions();
  const [i, setI] = useState(0);
  const x = useSharedValue(0);
  const pager = useRef<ScrollView>(null);
  const android = Platform.OS === 'android';

  const steps: Step[] = [
    {
      key: 'hello',
      title: 'Send files between your phone and laptop',
      body: 'Over a USB cable or your Wi-Fi. Files go straight across and never touch the internet.',
      art: <Mark />,
    },
    {
      key: 'cable',
      title: 'Plug in',
      body: 'Start fshare on your laptop, then connect your phone with a cable. They find each other.',
      art: <CableArt />,
      extra: <Command text="npx fshare-cli" />,
    },
    {
      key: 'wifi',
      title: 'No cable? Use Wi-Fi',
      body: 'Put both on the same network, press q in fshare on your laptop and scan the code. Phones running fshare show up on their own.',
      art: <WifiArt />,
    },
  ];
  const last = i === steps.length - 1;
  const cta = last ? 'Get started' : null;
  const [setup, setSetup] = useState(false);

  // Android only: saving needs a folder the user picks, once. That's setup, not part of the tour,
  // so it gets its own screen after the tour.
  const finish = () => {
    if (!android || getSaveDir()) return onDone();
    setSetup(true);
  };

  const go = (n: number) => {
    setI(n);
    pager.current?.scrollTo({ x: n * width, animated: true });
  };
  const next = () => {
    haptic.tap();
    if (!last) return go(i + 1);
    finish();
  };
  const onScroll = useAnimatedScrollHandler((e) => x.set(e.contentOffset.x / width));

  if (setup) return <FolderSetup onDone={onDone} />;

  return (
    <SafeAreaView style={st.root}>
      <View style={st.top}>
        {/* hidden (not just disabled) where they don't apply, so the bar keeps its layout */}
        <View style={{ opacity: i > 0 ? 1 : 0 }} pointerEvents={i > 0 ? 'auto' : 'none'} accessibilityElementsHidden={i === 0}>
          <Press
            style={st.back}
            onPress={() => {
              haptic.select();
              go(i - 1);
            }}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Back"
          >
            <Ionicons name="chevron-back" size={20} color={t.text} />
          </Press>
        </View>
        <View style={{ flex: 1 }} />
        <View style={{ opacity: last ? 0 : 1 }} pointerEvents={last ? 'none' : 'auto'} accessibilityElementsHidden={last}>
          <Press
            style={st.skip}
            onPress={() => {
              haptic.select();
              finish();
            }}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text style={st.skipText}>Skip</Text>
          </Press>
        </View>
      </View>

      <Animated.ScrollView
        ref={pager as never}
        horizontal
        pagingEnabled
        bounces={false}
        showsHorizontalScrollIndicator={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onMomentumScrollEnd={(e) => {
          const n = Math.round(e.nativeEvent.contentOffset.x / width);
          if (n !== i) {
            haptic.select();
            setI(n);
          }
        }}
      >
        {steps.map((s, k) => (
          <Page key={s.key} index={k} x={x} width={width} step={s} active={k === i} />
        ))}
      </Animated.ScrollView>

      <View style={st.foot}>
        <Dots count={steps.length} x={x} index={i} />
        <View style={{ flex: 1 }} />
        <NextButton label={cta} onPress={next} />
      </View>
    </SafeAreaView>
  );
}

// The drawing drifts while swiping and the words fade, so the pages read as layers.
function Page({ index, x, width, step, active }: { index: number; x: SharedValue<number>; width: number; step: Step; active: boolean }) {
  const [st] = useStyles(styles);
  const art = useAnimatedStyle(() => {
    const d = x.get() - index;
    return {
      opacity: interpolate(Math.abs(d), [0, 0.8], [1, 0], 'clamp'),
      transform: [{ translateX: interpolate(d, [-1, 0, 1], [-width * 0.3, 0, width * 0.3]) }],
    };
  });
  const words = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(x.get() - index), [0, 0.6], [1, 0], 'clamp') }));
  return (
    <View
      style={{ width, flex: 1 }}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? 'auto' : 'no-hide-descendants'}
    >
      <Animated.View style={[st.art, art]}>{step.art}</Animated.View>
      <Animated.View style={[st.words, words]}>
        <Text style={st.title} accessibilityRole="header">
          {step.title}
        </Text>
        <Text style={st.body}>{step.body}</Text>
        {step.extra}
      </Animated.View>
    </View>
  );
}

// Page dots, bottom left: the current one grows a little and turns lime, following the finger.
function Dots({ count, x, index }: { count: number; x: SharedValue<number>; index: number }) {
  const [st] = useStyles(styles);
  return (
    <View style={st.dots} accessible accessibilityLabel={`Step ${index + 1} of ${count}`}>
      {Array.from({ length: count }, (_, k) => (
        <Dot key={k} index={k} x={x} />
      ))}
    </View>
  );
}
function Dot({ index, x }: { index: number; x: SharedValue<number> }) {
  const t = useTheme();
  const style = useAnimatedStyle(() => {
    const near = Math.max(0, 1 - Math.abs(x.get() - index)); // 1 on this page, 0 a page away
    return { width: 7 + near * 13, backgroundColor: interpolateColor(near, [0, 1], [t.surface3, t.accent]) };
  });
  return <Animated.View style={[{ height: 7, borderRadius: 3.5 }, style]} />;
}

// Round arrow on most pages; on the last it springs open into a labelled pill while the arrow
// slides out ahead and the label settles in behind it.
function NextButton({ label, onPress }: { label: string | null; onPress: () => void }) {
  const [st, t] = useStyles(styles);
  const [pillW, setPillW] = useState(0);
  const [shown, setShown] = useState(label); // keeps the text while the pill closes again
  const p = useSharedValue(label ? 1 : 0);
  useEffect(() => {
    if (label) setShown(label);
    p.set(withSpring(label ? 1 : 0, { duration: 520, dampingRatio: 0.72, reduceMotion: ReduceMotion.System }));
  }, [label]);
  const box = useAnimatedStyle(() => ({ width: interpolate(p.get(), [0, 1], [64, Math.max(64, pillW)]) }));
  const arrow = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0, 0.45], [1, 0], 'clamp'),
    transform: [{ translateX: interpolate(p.get(), [0, 1], [0, 26]) }, { scale: interpolate(p.get(), [0, 1], [1, 0.6]) }],
  }));
  const text = useAnimatedStyle(() => ({
    opacity: interpolate(p.get(), [0.35, 1], [0, 1], 'clamp'),
    transform: [{ translateX: interpolate(p.get(), [0, 1], [-14, 0]) }],
  }));
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label ?? 'Next'}>
      <Animated.View style={[st.next, box]}>
        <Animated.View style={[StyleSheet.absoluteFill, st.center, arrow]}>
          <Ionicons name="arrow-forward" size={22} color={t.onAccent} />
        </Animated.View>
        <Animated.Text style={[st.nextText, text]} numberOfLines={1}>
          {shown}
        </Animated.Text>
      </Animated.View>
      {/* measures the pill's width for whichever label is coming */}
      <Text
        style={[st.nextText, st.measure]}
        onLayout={(e) => setPillW(e.nativeEvent.layout.width + 60)}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        {label ?? shown ?? ''}
      </Text>
    </Press>
  );
}

// ── illustrations ───────────────────────────────────────────────────────────
// One style for all of them: solid rounded shapes like the app's own cards, lime for what moves,
// the logo alone sits on a slowly turning cookie outline.
const PHI = (1 + Math.sqrt(5)) / 2;
const AnimatedPath = Animated.createAnimatedComponent(Path);
const VW = 320,
  VH = 220;

function Ring({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ position: 'absolute' }}>
        <Cookie size={290} color={t.line} outline spin={90} />
      </View>
      {children}
    </View>
  );
}

function Scene({ children }: { children: ReactNode }) {
  return <View style={{ width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}>{children}</View>;
}

// The app's mark: the scalloped cookie turning slowly behind the ⇅ arrows (same proportions as the icon).
function Mark() {
  const t = useTheme();
  const size = 180;
  const d = size * 0.92; // the cookie's diameter inside <Cookie>
  const h = d / PHI ** 2,
    gap = h / PHI,
    sw = h / PHI ** 4,
    reach = h / PHI ** 3 / Math.SQRT2;
  const c = size / 2,
    top = c - h / 2 + sw / 2,
    bot = c + h / 2 - sw / 2,
    lx = c - gap / 2,
    rx = c + gap / 2;
  const arrows = `M${lx} ${bot}V${top}M${lx - reach} ${top + reach}L${lx} ${top}L${lx + reach} ${top + reach}M${rx} ${top}V${bot}M${rx - reach} ${bot - reach}L${rx} ${bot}L${rx + reach} ${bot - reach}`;
  return (
    <Ring>
      <Cookie size={size} color={t.accent} spin={40}>
        <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
          <Path d={arrows} stroke={t.onAccent} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </Svg>
      </Cookie>
    </Ring>
  );
}

// A looping 0 → 1 value; still when the system asks for reduced motion.
function useLoop(ms: number, delay = 0) {
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 0.5 : 0);
  useEffect(() => {
    if (reduced) return;
    p.set(
      withDelay(
        delay,
        withRepeat(withTiming(1, { duration: ms, easing: Easing.inOut(Easing.quad), reduceMotion: ReduceMotion.Never }), -1),
      ),
    );
  }, [reduced]);
  return p;
}

// a small scalloped blob, the app's mark, for the phone's screen
function blob(cx: number, cy: number, r: number) {
  return (
    Array.from({ length: 73 }, (_, i) => {
      const th = (i / 72) * Math.PI * 2;
      const rr = r * (1 + 0.08 * Math.cos(9 * th));
      return `${i ? 'L' : 'M'}${(cx + rr * Math.cos(th)).toFixed(1)} ${(cy + rr * Math.sin(th)).toFixed(1)}`;
    }).join('') + 'Z'
  );
}

// The laptop runs the CLI: a lime prompt and a few lines of output.
function Laptop({ x, y }: { x: number; y: number }) {
  const t = useTheme();
  return (
    <>
      <Rect x={x} y={y} width={120} height={80} rx={12} fill={t.surface3} />
      <Rect x={x + 6} y={y + 6} width={108} height={68} rx={7} fill={t.bg} />
      <Path
        d={`M${x + 17} ${y + 19}l6 5l-6 5`}
        stroke={t.accent}
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <Rect x={x + 30} y={y + 21.5} width={44} height={5} rx={2.5} fill={t.faint} />
      <Rect x={x + 17} y={y + 36} width={64} height={5} rx={2.5} fill={t.surface3} />
      <Rect x={x + 17} y={y + 48} width={50} height={5} rx={2.5} fill={t.surface3} />
      <Rect x={x + 71} y={y + 47} width={8} height={7} rx={1.5} fill={t.accent} />
      <Rect x={x - 12} y={y + 86} width={144} height={10} rx={5} fill={t.surface3} />
    </>
  );
}
// The phone runs the app: its mark on the screen.
function Phone({ x, y }: { x: number; y: number }) {
  const t = useTheme();
  return (
    <>
      <Rect x={x} y={y} width={58} height={104} rx={15} fill={t.surface3} />
      <Rect x={x + 5} y={y + 5} width={48} height={94} rx={11} fill={t.bg} />
      <Rect x={x + 21} y={y + 10} width={16} height={4} rx={2} fill={t.surface3} />
      <Path d={blob(x + 29, y + 54, 13)} fill={t.accent} />
    </>
  );
}

const SCENE = { width: 304, height: 209 };

function CableArt() {
  const t = useTheme();
  const p = useLoop(1500);
  const cable = 'M160 158 C 188 200, 238 200, 261 160'; // from the laptop's edge, drooping into the phone
  const LEN = 116;
  const pulse = useAnimatedProps(() => ({ strokeDashoffset: LEN - p.get() * (LEN + 18) }));
  return (
    <Scene>
      <Svg {...SCENE} viewBox={`0 0 ${VW} ${VH}`}>
        <Laptop x={28} y={66} />
        <Phone x={232} y={54} />
        <Path d={cable} stroke={t.surface3} strokeWidth={7} strokeLinecap="round" fill="none" />
        <AnimatedPath
          d={cable}
          stroke={t.accent}
          strokeWidth={7}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={`18 ${LEN}`}
          animatedProps={pulse}
        />
      </Svg>
    </Scene>
  );
}

// Signal arcs leave the phone one after another toward the laptop.
function Arc({ r, delay }: { r: number; delay: number }) {
  const t = useTheme();
  const p = useLoop(1700, delay);
  const props = useAnimatedProps(() => ({ strokeOpacity: interpolate(p.get(), [0, 0.35, 1], [0.2, 1, 0.2]) }));
  const cx = 98,
    cy = 106,
    a = Math.PI / 4.2;
  const d = `M${cx + r * Math.cos(-a)} ${cy + r * Math.sin(-a)} A ${r} ${r} 0 0 1 ${cx + r * Math.cos(a)} ${cy + r * Math.sin(a)}`;
  return <AnimatedPath d={d} stroke={t.accent} strokeWidth={8} strokeLinecap="round" fill="none" animatedProps={props} />;
}

function WifiArt() {
  return (
    <Scene>
      <Svg {...SCENE} viewBox={`0 0 ${VW} ${VH}`}>
        <Phone x={30} y={54} />
        <Arc r={20} delay={0} />
        <Arc r={36} delay={200} />
        <Arc r={52} delay={400} />
        <Laptop x={176} y={66} />
      </Svg>
    </Scene>
  );
}

// ── save folder (Android) ───────────────────────────────────────────────────
// Its own screen after the tour: what Android needs, where files will land, then a choice.
function FolderSetup({ onDone }: { onDone: () => void }) {
  const [st, t] = useStyles(styles);
  const choose = async () => {
    haptic.tap();
    await pickSaveDir(); // cancelling is fine: the app asks again on the first download
    onDone();
  };
  return (
    <Animated.View entering={FadeIn.duration(320).reduceMotion(ReduceMotion.System)} style={st.root}>
      <SafeAreaView style={{ flex: 1 }}>
        <Animated.View entering={rise(0)} style={[st.art, { justifyContent: 'flex-end', paddingBottom: 12 }]}>
          <FolderScene />
        </Animated.View>
        <Animated.View entering={rise(1)} style={st.words}>
          <Text style={st.eyebrow}>One more thing</Text>
          <Text style={st.title} accessibilityRole="header">
            Choose where files go
          </Text>
          <Text style={st.body}>
            Android saves to a folder you pick, once. Make one called fshare inside Download, then tap Use this folder.
          </Text>
          <View style={st.where} accessible accessibilityLabel="Download, then fshare">
            <Ionicons name="folder-outline" size={15} color={t.dim} />
            <Text style={st.whereDir}>Download</Text>
            <Ionicons name="chevron-forward" size={12} color={t.faint} />
            <Ionicons name="folder" size={15} color={t.accent} />
            <Text style={st.wherePath}>fshare</Text>
          </View>
        </Animated.View>
        <Animated.View entering={rise(2)} style={st.setupFoot}>
          <Press
            grow
            style={st.secondaryBtn}
            onPress={() => {
              haptic.select();
              onDone();
            }}
            accessibilityRole="button"
          >
            <Text style={st.secondaryText}>Not now</Text>
          </Press>
          <Press grow style={st.primary} onPress={choose} accessibilityRole="button" accessibilityLabel="Choose folder">
            <Text style={st.primaryText}>Choose folder</Text>
          </Press>
        </Animated.View>
      </SafeAreaView>
    </Animated.View>
  );
}

const rise = (k: number) =>
  FadeInDown.delay(80 + k * 70)
    .duration(460)
    .easing(Easing.bezier(0.23, 1, 0.32, 1))
    .withInitialValues({ transform: [{ translateY: 12 }] })
    .reduceMotion(ReduceMotion.System);

// One 4.6 s loop. The front of the folder tips open on its hinge, three files fall in on soft
// curves and settle at different depths, the front shuts with a small overshoot and the check
// pressed into it pulses once. Then the files lift out and it starts again.
// Reduced motion: the filled folder, still.
const LOOP = 4600;
const DROPS = [250, 700, 1150]; // when each file starts falling
const FALL = 620;
const SHUT = 1900; // the front closes
// 0..1 progress through [a, b] ms of the loop
function at(v: number, a: number, b: number) {
  'worklet';
  return Math.min(1, Math.max(0, (v * LOOP - a) / (b - a)));
}
// a file falling in at `from` ms: in from the side on a curve, tilt easing out, a soft settle;
// at the end of the loop it lifts back out
function useDrop(p: SharedValue<number>, from: number, dx: number, tilt: number, depth: number) {
  return useAnimatedStyle(() => {
    const v = p.get();
    const k = at(v, from, from + FALL);
    const fall = Easing.out(Easing.back(1.3))(k);
    const out = Easing.in(Easing.cubic)(at(v, 3900, 4450));
    return {
      opacity: at(v, from, from + 160) * (1 - out),
      transform: [
        { translateX: dx * (1 - Easing.out(Easing.cubic)(k)) },
        { translateY: -110 + fall * (110 + depth) - out * 26 },
        { rotate: `${tilt * (1 - Easing.out(Easing.cubic)(k))}deg` },
      ],
    };
  });
}

function FolderScene() {
  const t = useTheme();
  const reduced = useReducedMotion();
  const p = useSharedValue(reduced ? 0.7 : 0);
  useEffect(() => {
    if (reduced) return;
    p.set(withRepeat(withTiming(1, { duration: LOOP, easing: Easing.linear, reduceMotion: ReduceMotion.Never }), -1));
  }, [reduced]);

  const photo = useDrop(p, DROPS[0], -64, -12, 10);
  const doc = useDrop(p, DROPS[1], 64, 10, 4);
  const video = useDrop(p, DROPS[2], -30, -6, 16);
  // the front panel: tips open while files go in, shuts with a little overshoot
  const front = useAnimatedStyle(() => {
    const v = p.get();
    const open = Easing.out(Easing.cubic)(at(v, 100, 450));
    const shut = Easing.out(Easing.back(2.4))(at(v, SHUT, SHUT + 420));
    return { transform: [{ scaleY: 1 - (open - shut) * 0.1 }] }; // the top edge dips toward the hinge
  });
  // the whole folder settles down a touch as it closes
  const body = useAnimatedStyle(() => {
    const k = at(p.get(), SHUT + 120, SHUT + 420);
    const q = Math.sin(k * Math.PI);
    return { transform: [{ translateY: q * 2.5 }, { scaleY: 1 - q * 0.025 }, { scaleX: 1 + q * 0.015 }] };
  });
  const shadow = useAnimatedStyle(() => {
    const q = Math.sin(at(p.get(), SHUT + 120, SHUT + 420) * Math.PI);
    return { transform: [{ scaleX: 1 + q * 0.08 }], opacity: 0.55 + q * 0.3 };
  });
  // the check pressed into the front is always there; it pulses once when the folder closes
  const check = useAnimatedStyle(() => {
    const q = Math.sin(at(p.get(), SHUT + 250, SHUT + 750) * Math.PI);
    return { opacity: 0.2 + q * 0.16, transform: [{ scale: 1 + q * 0.12 }] };
  });

  const W = 212,
    H = 158;
  const back = t.scheme === 'dark' ? '#9DC84E' : '#36510A';
  return (
    <View style={{ width: W, height: 230, alignItems: 'center', justifyContent: 'flex-end', transform: [{ scale: 0.78 }] }}>
      <Animated.View style={[{ width: 150, height: 12, borderRadius: 6, backgroundColor: t.surface2 }, shadow]} />
      <Animated.View style={[{ position: 'absolute', bottom: 12, width: W, height: H, transformOrigin: 'bottom' }, body]}>
        <Svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={StyleSheet.absoluteFill}>
          <Path
            d="M2 18a14 14 0 0 1 14-14h52c6 0 9 2 13 6l4 4c3 3 6 4 10 4h101a14 14 0 0 1 14 14v112a14 14 0 0 1-14 14H16a14 14 0 0 1-14-14z"
            fill={back}
          />
        </Svg>
        {/* the files settle between the panels at different depths */}
        <Animated.View style={[styles2.file, { marginLeft: -78 }, photo]}>
          <PhotoCard />
        </Animated.View>
        <Animated.View style={[styles2.file, { marginLeft: 70 }, doc]}>
          <DocCard />
        </Animated.View>
        <Animated.View style={[styles2.file, { marginLeft: -6 }, video]}>
          <VideoCard />
        </Animated.View>
        <Animated.View style={[{ position: 'absolute', left: 0, right: 0, top: 34, bottom: 0, transformOrigin: 'bottom' }, front]}>
          <Svg width={W} height={H - 34} viewBox={`0 34 ${W} ${H - 34}`}>
            <Path d="M2 48a14 14 0 0 1 14-14h180a14 14 0 0 1 14 14v96a14 14 0 0 1-14 14H16a14 14 0 0 1-14-14z" fill={t.accent} />
            <Path d="M16 35.2h180" stroke="#ffffff" strokeOpacity={0.45} strokeWidth={1.5} strokeLinecap="round" />
          </Svg>
          <Animated.View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }, check]}>
            <Svg width={56} height={42} viewBox="0 0 56 42">
              <Path d="M7 21l14 14L49 7" stroke="#000000" strokeWidth={10} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </Svg>
          </Animated.View>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

// the files: a photo, a document and a video, each a small card with a soft shadow
function PhotoCard() {
  const t = useTheme();
  return (
    <View style={styles2.card}>
      <Svg width={60} height={72} viewBox="0 0 60 72">
        <Rect x={0} y={0} width={60} height={72} rx={10} fill="#F4F5EF" />
        <Rect x={6} y={6} width={48} height={44} rx={6} fill={t.accentSoft} />
        <Path d="M6 40l12-11 9 8 9-9 18 16v0a6 6 0 0 1-6 6H12a6 6 0 0 1-6-6z" fill={t.accent} opacity={0.65} />
        <Path d="M6 44l14-9 12 9 6-3 16 9a6 6 0 0 1-6 0H12a6 6 0 0 1-6-6z" fill={t.accent} />
        <Rect x={38} y={12} width={9} height={9} rx={4.5} fill={t.accent} />
        <Rect x={8} y={58} width={30} height={5} rx={2.5} fill="#C9CBC2" />
      </Svg>
    </View>
  );
}
function DocCard() {
  const t = useTheme();
  return (
    <View style={styles2.card}>
      <Svg width={56} height={72} viewBox="0 0 56 72">
        <Path d="M10 0h28l18 18v44a10 10 0 0 1-10 10H10A10 10 0 0 1 0 62V10A10 10 0 0 1 10 0z" fill="#F4F5EF" />
        <Path d="M38 0v10a8 8 0 0 0 8 8h10z" fill="#D9DBD2" />
        <Rect x={9} y={26} width={26} height={6} rx={3} fill={t.accent} />
        <Rect x={9} y={39} width={36} height={4.5} rx={2.25} fill="#C9CBC2" />
        <Rect x={9} y={49} width={30} height={4.5} rx={2.25} fill="#C9CBC2" />
        <Rect x={9} y={59} width={33} height={4.5} rx={2.25} fill="#C9CBC2" />
      </Svg>
    </View>
  );
}
function VideoCard() {
  const t = useTheme();
  return (
    <View style={styles2.card}>
      <Svg width={64} height={70} viewBox="0 0 64 70">
        <Rect x={0} y={0} width={64} height={70} rx={10} fill="#262724" />
        <Rect x={6} y={6} width={52} height={42} rx={6} fill="#3A3C37" />
        <Rect x={20} y={15} width={24} height={24} rx={12} fill={t.accent} />
        <Path d="M29 21.5l9 5.5-9 5.5z" fill="#121A00" />
        <Rect x={8} y={56} width={28} height={5} rx={2.5} fill="#5F625B" />
      </Svg>
    </View>
  );
}

const styles2 = StyleSheet.create({
  file: { position: 'absolute', left: 0, right: 0, top: -4, alignItems: 'center' },
  card: { borderRadius: 10, boxShadow: '0 4px 10px rgba(0,0,0,0.28)' },
});

// The laptop command as a small pill; the round button copies it.
function Command({ text }: { text: string }) {
  const [st, t] = useStyles(styles);
  const [copied, setCopied] = useState(false);
  return (
    <View style={st.code}>
      <Text style={st.codeText} selectable>
        {text}
      </Text>
      <Press
        style={[st.copy, copied && { backgroundColor: t.accentSoft }]}
        onPress={async () => {
          await Clipboard.setStringAsync(text);
          haptic.success();
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={copied ? 'Copied' : `${text}, copy`}
      >
        <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={12} color={copied ? t.onAccentSoft : t.faint} />
      </Press>
    </View>
  );
}

const mono = process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace';
// Android pads text above the glyphs (more with this font), which pushes labels low in buttons
const centered = { includeFontPadding: false, textAlignVertical: 'center' } as const;
const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    top: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16 },
    back: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skip: {
      height: 36,
      paddingHorizontal: 16,
      borderRadius: 18,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    skipText: { color: t.dim, fontSize: 14, lineHeight: 18, fontFamily: font.semibold, ...centered },
    dots: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      height: 26,
      paddingHorizontal: 10,
      borderRadius: 13,
      backgroundColor: t.surface,
      marginLeft: 12,
    },

    art: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
    words: { paddingHorizontal: 28, paddingTop: 8, paddingBottom: 8, minHeight: 236, gap: 12 },
    title: { color: t.text, fontSize: 32, lineHeight: 39, fontFamily: font.heavy, letterSpacing: -1.1 },
    body: { color: t.dim, fontSize: 16.5, lineHeight: 25, fontFamily: font.medium, maxWidth: 360 },

    code: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 8,
      marginTop: 6,
      paddingLeft: 12,
      paddingRight: 3,
      height: 30,
      borderRadius: 15,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
    },
    codeText: { color: t.dim, fontSize: 12.5, fontFamily: mono },
    copy: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' },

    // save-folder screen (Android)
    eyebrow: { color: t.accent, fontSize: 14, lineHeight: 18, fontFamily: font.bold, marginBottom: -4 },
    where: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 6,
      marginTop: 8,
      height: 36,
      paddingHorizontal: 14,
      borderRadius: 18,
      backgroundColor: t.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: t.line,
    },
    whereDir: { color: t.dim, fontSize: 14.5, lineHeight: 19, fontFamily: font.semibold, ...centered },
    wherePath: { color: t.text, fontSize: 14.5, lineHeight: 19, fontFamily: font.bold, ...centered },
    setupFoot: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8, gap: 10 },
    primary: {
      flexDirection: 'row',
      gap: 10,
      height: 58,
      borderRadius: 29,
      backgroundColor: t.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryBtn: {
      height: 58,
      borderRadius: 29,
      backgroundColor: t.surface2,
      borderWidth: 1,
      borderColor: t.line,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryText: { color: t.text, fontSize: 16, lineHeight: 20, fontFamily: font.semibold, ...centered },
    primaryText: { color: t.onAccent, fontSize: 16, lineHeight: 20, fontFamily: font.bold, ...centered },

    foot: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 16, paddingVertical: 12 },
    next: { height: 64, borderRadius: 32, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
    center: { alignItems: 'center', justifyContent: 'center' },
    measure: { position: 'absolute', opacity: 0, left: -1000 },
    nextText: { color: t.onAccent, fontSize: 17, lineHeight: 22, fontFamily: font.bold, ...centered },
  });
