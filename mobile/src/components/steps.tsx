import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useStyles, type Theme } from '../theme';

export function Step({ n, children }: { n: number; children: ReactNode }) {
  const [st] = useStyles(styles);
  return (
    <View style={st.step}>
      <View style={st.num}>
        <Text style={st.numText}>{n}</Text>
      </View>
      <Text style={st.text}>{children}</Text>
    </View>
  );
}

// There's nothing to press for a cable: it connects when plugged in. This says how.
export function CableSteps() {
  const [st] = useStyles(styles);
  return (
    <View style={{ gap: 14, paddingHorizontal: 4 }}>
      <Step n={1}>Use a USB-C cable that carries data (some charging cables don’t).</Step>
      <Step n={2}>Plug it into this phone and the other one, with fshare open on both.</Step>
      <Step n={3}>Tap Allow, then Open fshare, if the phones ask. It connects by itself.</Step>
      <Text style={st.hint}>
        Nothing happening? On OnePlus, Oppo and Realme phones, turn on OTG in Settings. A laptop over USB also works this way.
      </Text>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    step: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    num: { width: 24, height: 24, borderRadius: 12, backgroundColor: t.accentSoft, alignItems: 'center', justifyContent: 'center' },
    numText: { color: t.onAccentSoft, fontSize: 12, fontWeight: '700' },
    text: { flex: 1, color: t.dim, fontSize: 15, lineHeight: 21 },
    hint: { color: t.faint, fontSize: 13, lineHeight: 19, marginTop: 4 },
  });
