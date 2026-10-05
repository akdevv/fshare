// The rows under Appearance in Settings: this phone's name, notifications, and keeping
// transfers going while minimized. Each saves to prefs as soon as it changes.
import { useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { haptic, useStyles, type Theme } from './theme';
import { Press, Toggle } from './ui';
import { me, rename } from './identity';
import { readPrefs, writePrefs } from './prefs';

export function Preferences({ onKeepAlive }: { onKeepAlive: (on: boolean) => void }) {
  const [st, t] = useStyles(styles);
  const [name, setName] = useState(me.name);
  const [editing, setEditing] = useState(false);
  const input = useRef<TextInput>(null);
  const [notify, setNotify] = useState(readPrefs().notify !== false);
  const [keep, setKeep] = useState(readPrefs().keepAlive !== false);
  const saveName = () => {
    setEditing(false);
    const n = name.trim();
    if (!n) return setName(me.name);
    if (n !== me.name) rename(n);
    setName(n);
  };

  return (
    <View style={{ gap: 10 }}>
      <Text style={st.label}>This phone</Text>
      <View style={st.group}>
        <View style={st.row}>
          <View style={st.tile}>
            <Ionicons name="phone-portrait-outline" size={17} color={t.text} />
          </View>
          <View style={{ flex: 1, gap: 1 }}>
            <Text style={st.meta}>Name</Text>
            <TextInput
              ref={input}
              style={st.input}
              value={name}
              onChangeText={setName}
              editable={editing}
              onBlur={saveName}
              onSubmitEditing={saveName}
              maxLength={40}
              returnKeyType="done"
              selectTextOnFocus
              placeholderTextColor={t.faint}
              accessibilityLabel="Phone name"
            />
          </View>
          {/* only the button opens the name for editing; while editing it saves */}
          <Press
            style={[st.edit, editing && { backgroundColor: t.accent }]}
            hitSlop={8}
            onPress={() => {
              haptic.tap();
              if (editing) return input.current?.blur();
              setEditing(true);
              setTimeout(() => input.current?.focus(), 50);
            }}
            accessibilityRole="button"
            accessibilityLabel={editing ? 'Save name' : 'Edit name'}
          >
            <Ionicons name={editing ? 'checkmark' : 'pencil'} size={15} color={editing ? t.onAccent : t.text} />
          </Press>
        </View>
        <View style={st.sep} />
        <Switch
          icon="notifications-outline"
          title="Notifications"
          detail="When a transfer finishes"
          on={notify}
          onChange={(v) => {
            setNotify(v);
            writePrefs({ notify: v });
          }}
        />
        <View style={st.sep} />
        <Switch
          icon="sync-outline"
          title="Run in background"
          detail="Keep transfers going when minimized"
          on={keep}
          onChange={(v) => {
            setKeep(v);
            writePrefs({ keepAlive: v });
            onKeepAlive(v);
          }}
        />
      </View>
    </View>
  );
}

function Switch({
  icon,
  title,
  detail,
  on,
  onChange,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  const [st, t] = useStyles(styles);
  return (
    <Press
      style={st.row}
      highlight={t.surface3}
      onPress={() => {
        haptic.toggle(!on);
        onChange(!on);
      }}
      accessibilityRole="switch"
      accessibilityState={{ checked: on }}
      accessibilityLabel={title}
    >
      <View style={[st.tile, on && { backgroundColor: t.accentSoft }]}>
        <Ionicons name={icon} size={17} color={on ? t.onAccentSoft : t.dim} />
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={st.title}>{title}</Text>
        <Text style={st.meta} numberOfLines={1}>
          {detail}
        </Text>
      </View>
      <Toggle on={on} />
    </Press>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    label: { color: t.dim, fontSize: 14, fontWeight: '600', paddingHorizontal: 4 },
    group: { backgroundColor: t.surface2, borderRadius: 16, borderCurve: 'continuous', overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 12, paddingVertical: 10 },
    sep: { height: StyleSheet.hairlineWidth, backgroundColor: t.line, marginLeft: 60 },
    tile: {
      width: 36,
      height: 36,
      borderRadius: 11,
      borderCurve: 'continuous',
      backgroundColor: t.surface3,
      alignItems: 'center',
      justifyContent: 'center',
    },
    edit: { width: 34, height: 34, borderRadius: 17, backgroundColor: t.surface3, alignItems: 'center', justifyContent: 'center' },
    title: { color: t.text, fontSize: 15, fontWeight: '600' },
    meta: { color: t.dim, fontSize: 13 },
    input: { color: t.text, fontSize: 15, fontWeight: '600', padding: 0 },
  });
