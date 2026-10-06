// First launch only: what fshare does and how to connect, then on Android where files go.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import Animated, {
  FadeIn,
  interpolate,
  interpolateColor,
  ReduceMotion,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  type SharedValue,
} from 'react-native-reanimated';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { getSaveDir, pickSaveDir } from '../lib/downloads';
import { font, haptic, useStyles, useTheme, type Theme } from '../theme';
import { CableArt, FolderScene, Mark, WifiArt } from '../components/illustrations';
import { rise } from '../components/motion';
import { Press } from '../components/ui';

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
      body: 'Run fshare on your laptop, then connect your phone with a cable. They find each other.',
      art: <CableArt />,
      extra: <Command text="fshare" hint="First time? Install it from github.com/akdevv/fshare" />,
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

// Android only, after the tour: saving needs a folder picked once, so this explains where and asks.
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
        <Animated.View entering={rise(80, 12, 460)} style={[st.art, { justifyContent: 'flex-end', paddingBottom: 12 }]}>
          <FolderScene />
        </Animated.View>
        <Animated.View entering={rise(150, 12, 460)} style={st.words}>
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
        <Animated.View entering={rise(220, 12, 460)} style={st.setupFoot}>
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

// The laptop command as a small pill; the round button copies it.
function Command({ text, hint }: { text: string; hint?: string }) {
  const [st, t] = useStyles(styles);
  const [copied, setCopied] = useState(false);
  return (
    <View style={{ gap: 8 }}>
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
      {hint && <Text style={st.hint}>{hint}</Text>}
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
    hint: { color: t.faint, fontSize: 13, lineHeight: 18, fontFamily: font.medium },
    copy: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.surface, alignItems: 'center', justifyContent: 'center' },

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
    setupFoot: { flexDirection: 'row', paddingHorizontal: 16, paddingTop: 40, paddingBottom: 12, gap: 10 },
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
