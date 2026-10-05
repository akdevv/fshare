// First launch only: three short steps, then (Android) pick the save folder once.
import { useState } from 'react';
import { Image, Platform, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, FadeIn, FadeInDown, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { pickSaveDir } from './downloads';
import { haptic, useStyles, type Theme } from './theme';
import { Cookie, EASE_OUT, Press } from './ui';

type Step = { icon: keyof typeof Ionicons.glyphMap; title: string; body: string; code?: string };

const STEPS: Step[] = [
  {
    icon: 'swap-vertical',
    title: 'Welcome to fshare',
    body: 'Send files between your phone, your laptop and other phones. Fast, private, no cloud.',
  },
  {
    icon: 'flash',
    title: 'Plug in and go',
    body: 'Run fshare on your laptop and connect a USB cable. It connects by itself.',
    code: 'npx fshare-cli',
  },
  { icon: 'wifi', title: 'Or go wireless', body: 'On the same Wi-Fi, scan the QR code from your laptop, or pick a phone nearby.' },
  ...(Platform.OS === 'android'
    ? [
        {
          icon: 'folder-open' as const,
          title: 'Where files go',
          body: 'Pick a folder inside Download once. Everything you receive is saved there automatically.',
        },
      ]
    : []),
];

const enter = FadeInDown.duration(420)
  .easing(Easing.bezier(0.23, 1, 0.32, 1))
  .withInitialValues({ transform: [{ translateY: 12 }] })
  .reduceMotion(ReduceMotion.System);
const leave = FadeOut.duration(140).reduceMotion(ReduceMotion.System);

export function Onboarding({ onDone }: { onDone: () => void }) {
  const [st, t] = useStyles(styles);
  const [i, setI] = useState(0);
  const step = STEPS[i];
  const last = i === STEPS.length - 1;
  const folder = Platform.OS === 'android' && last;

  const next = async () => {
    haptic.tap();
    if (!last) return setI(i + 1);
    if (folder) await pickSaveDir(); // cancelling is fine: the app asks again on the first download
    onDone();
  };

  return (
    <SafeAreaView style={st.root}>
      <View style={st.top}>
        {!last && (
          <Press
            style={st.skip}
            onPress={() => {
              haptic.select();
              onDone();
            }}
            hitSlop={10}
            accessibilityRole="button"
          >
            <Text style={st.skipText}>Skip</Text>
          </Press>
        )}
      </View>

      <View style={st.body}>
        <Animated.View key={`hero${i}`} entering={FadeIn.duration(300).reduceMotion(ReduceMotion.System)} exiting={leave} style={st.hero}>
          {i === 0 ? (
            <Image source={require('./assets/icon.png')} style={st.icon} accessibilityIgnoresInvertColors />
          ) : (
            <Cookie size={168} color={t.accentSoft} spin={30}>
              <Ionicons name={step.icon} size={56} color={t.onAccentSoft} />
            </Cookie>
          )}
        </Animated.View>
        <Animated.View key={`text${i}`} entering={enter.delay(60)} exiting={leave} style={{ alignItems: 'center', gap: 12 }}>
          <Text style={st.title} accessibilityRole="header">
            {step.title}
          </Text>
          <Text style={st.text}>{step.body}</Text>
          {step.code && (
            <View style={st.code}>
              <Text style={st.codeText} selectable>
                {step.code}
              </Text>
            </View>
          )}
        </Animated.View>
      </View>

      <View style={st.foot}>
        <View style={st.dots} accessible accessibilityLabel={`Step ${i + 1} of ${STEPS.length}`}>
          {STEPS.map((_, k) => (
            <Animated.View
              key={k}
              style={[
                st.dot,
                {
                  width: k === i ? 22 : 7,
                  backgroundColor: k === i ? t.accent : t.surface3,
                  transitionProperty: ['width', 'backgroundColor'],
                  transitionDuration: 240,
                  transitionTimingFunction: EASE_OUT,
                },
              ]}
            />
          ))}
        </View>
        <Press
          style={st.primary}
          onPress={next}
          accessibilityRole="button"
          accessibilityLabel={folder ? 'Choose folder' : last ? 'Get started' : 'Continue'}
        >
          <Text style={st.primaryText}>{folder ? 'Choose folder' : last ? 'Get started' : 'Continue'}</Text>
          {!folder && <Ionicons name="arrow-forward" size={19} color={t.onAccent} />}
        </Press>
        {folder && (
          <Press
            style={st.secondary}
            onPress={() => {
              haptic.select();
              onDone();
            }}
            accessibilityRole="button"
          >
            <Text style={st.secondaryText}>Later</Text>
          </Press>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg, paddingHorizontal: 16 },
    top: { height: 48, alignItems: 'flex-end', justifyContent: 'center' },
    skip: { height: 34, paddingHorizontal: 14, borderRadius: 17, justifyContent: 'center', backgroundColor: t.surface2 },
    skipText: { color: t.text, fontSize: 14, fontWeight: '600' },
    body: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 },
    hero: { marginBottom: 44, height: 168, justifyContent: 'center' },
    icon: { width: 136, height: 136, borderRadius: 34, borderCurve: 'continuous' },
    title: { color: t.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.8, textAlign: 'center' },
    text: { color: t.dim, fontSize: 16, lineHeight: 23, textAlign: 'center', maxWidth: 320 },
    code: {
      marginTop: 8,
      paddingHorizontal: 14,
      height: 36,
      borderRadius: 12,
      borderCurve: 'continuous',
      justifyContent: 'center',
      backgroundColor: t.surface2,
    },
    codeText: { color: t.text, fontSize: 14, fontFamily: process.env.EXPO_OS === 'ios' ? 'Menlo' : 'monospace' },
    foot: { gap: 18, paddingBottom: 12 },
    dots: { flexDirection: 'row', gap: 6, alignSelf: 'center' },
    dot: { height: 7, borderRadius: 4 },
    primary: {
      flexDirection: 'row',
      gap: 8,
      height: 58,
      borderRadius: 18,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.accent,
    },
    primaryText: { color: t.onAccent, fontSize: 17, fontWeight: '700' },
    secondary: { height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center', marginTop: -8 },
    secondaryText: { color: t.dim, fontSize: 15, fontWeight: '600' },
  });
