import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { SafeAreaView } from 'react-native-safe-area-context';
import { rise } from '../components/motion';
import { Step } from '../components/steps';
import { Cookie, Press } from '../components/ui';
import type { Device } from '../lib/device';
import { haptic, useStyles, type Theme } from '../theme';

// Connects to a laptop over Wi-Fi by its QR code (or the link under it), which carries the token.
export function Scanner({ onConnect, onBack }: { onConnect: (d: Device) => void; onBack: () => void }) {
  const [st, t] = useStyles(styles);
  const [perm, requestPerm] = useCameraPermissions();
  const [manual, setManual] = useState('');
  const [error, setError] = useState(false);
  const busy = useRef(false); // the camera reports a code many times a second

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
      setTimeout(() => (busy.current = false), 1500); // don't flag the same wrong code every frame
    }
  };

  return (
    <SafeAreaView style={st.root}>
      <View style={st.bar}>
        <Press
          style={st.back}
          onPress={() => {
            haptic.tap();
            onBack();
          }}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Back"
        >
          <Ionicons name="chevron-back" size={20} color={t.text} />
        </Press>
      </View>
      <Animated.View entering={rise(0)} style={{ paddingTop: 8, gap: 14 }}>
        <Text style={st.title} accessibilityRole="header">
          Connect over Wi-Fi
        </Text>
        <View style={{ gap: 10 }}>
          <Step n={1}>
            Run <Text style={st.code}>fshare</Text> on your laptop and press <Text style={st.code}>q</Text>
          </Step>
          <Step n={2}>Point the camera at the code it shows</Step>
        </View>
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
      <View style={st.hint}>
        <Ionicons name="wifi" size={14} color={t.faint} />
        <Text style={st.hintText}>Your phone and laptop need to be on the same Wi-Fi</Text>
      </View>
    </SafeAreaView>
  );
}

// Four thin corner brackets that breathe slowly; red when the code isn't fshare's.
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
    bar: { height: 52, flexDirection: 'row', alignItems: 'center' },
    back: { width: 40, height: 40, borderRadius: 20, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' },
    title: { color: t.text, fontSize: 26, fontWeight: '700', letterSpacing: -0.6 },
    text: { color: t.dim, fontSize: 15, lineHeight: 22, textAlign: 'center' },
    code: { color: t.text, fontWeight: '600' },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
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
    hint: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingBottom: 12 },
    hintText: { color: t.faint, fontSize: 13 },
  });
