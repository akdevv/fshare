import { StyleSheet, Text, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { me } from '../lib/identity';
import { font, useStyles, type Theme } from '../theme';
import { Cookie, Press } from './ui';

// A pairing request, either way round: the two phones with a link between them, who it is, the
// code both screens show, and the buttons.
export function PairCard({
  them,
  line,
  note,
  code,
  waiting,
  actions,
}: {
  them: string;
  line: string;
  note: string;
  code?: string;
  waiting?: boolean;
  actions: { label: string; primary?: boolean; onPress: () => void }[];
}) {
  const [st, t] = useStyles(styles);
  const reduced = useReducedMotion();
  return (
    <View style={st.pair}>
      <View style={st.art}>
        <Cookie size={64} color={t.surface3}>
          <Ionicons name="phone-portrait-outline" size={24} color={t.dim} />
        </Cookie>
        <View style={st.link}>
          {[0, 1, 2].map((i) => (
            <Animated.View
              key={i}
              style={[
                st.dot,
                !reduced && {
                  animationName: { '0%': { opacity: 0.25 }, '40%': { opacity: 1 }, '80%': { opacity: 0.25 }, '100%': { opacity: 0.25 } },
                  animationDuration: waiting ? '1.2s' : '2s',
                  animationDelay: `${i * 0.15}s`,
                  animationIterationCount: 'infinite',
                },
              ]}
            />
          ))}
        </View>
        <Cookie size={64} color={t.accentSoft}>
          <Ionicons name="phone-portrait-outline" size={24} color={t.onAccentSoft} />
        </Cookie>
      </View>
      <View style={{ alignItems: 'center', gap: 4 }}>
        <Text style={st.name} numberOfLines={1}>
          {them}
        </Text>
        <Text style={st.line}>{line}</Text>
      </View>
      {(code !== undefined || waiting) && (
        <View style={st.code} accessible accessibilityLabel={code ? `Code ${code.split('').join(' ')}` : 'Making a code'}>
          <Text style={[st.codeText, !code && { color: t.faint }]}>{code ? `${code.slice(0, 3)} ${code.slice(3)}` : '··· ···'}</Text>
        </View>
      )}
      <Text style={st.note}>{note}</Text>
      <Text style={st.me} numberOfLines={1}>
        You appear as {me.name}
      </Text>
      <View style={st.buttons}>
        {actions.map((a) => (
          <Press
            key={a.label}
            grow
            style={[st.button, a.primary && { backgroundColor: t.accent }]}
            onPress={a.onPress}
            accessibilityRole="button"
            accessibilityLabel={a.label}
          >
            <Text style={[st.buttonText, a.primary && { color: t.onAccent }]}>{a.label}</Text>
          </Press>
        ))}
      </View>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    pair: { alignItems: 'center', gap: 14, paddingTop: 8 },
    art: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 6 },
    link: { flexDirection: 'row', gap: 6 },
    dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent },
    name: { color: t.text, fontSize: 22, fontWeight: '700', letterSpacing: -0.4, maxWidth: 300 },
    line: { color: t.dim, fontSize: 15 },
    code: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 16, borderCurve: 'continuous', backgroundColor: t.surface2 },
    codeText: { color: t.text, fontSize: 30, fontFamily: font.mono, letterSpacing: 2, fontVariant: ['tabular-nums'] },
    note: { color: t.dim, fontSize: 14, lineHeight: 20, textAlign: 'center', paddingHorizontal: 16 },
    me: { color: t.faint, fontSize: 12.5 },
    buttons: { flexDirection: 'row', gap: 10, alignSelf: 'stretch', marginTop: 8 },
    button: {
      height: 54,
      borderRadius: 16,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: t.surface2,
    },
    buttonText: { color: t.text, fontSize: 16, fontWeight: '600' },
  });
