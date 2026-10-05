import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic, useStyles, type Theme } from './theme';
import { Press } from './ui';

export type SheetAction = {
  label: string;
  detail?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  destructive?: boolean;
  onPress: () => void;
};
export type SheetContent = {
  title: string;
  message?: string;
  subtitle?: ReactNode; // richer alternative to `message`
  extra?: ReactNode; // live content (e.g. the theme switch), rendered above the actions
  actions: SheetAction[];
  onCancel?: () => void;
};

const SHEET = { duration: 320, easing: Easing.bezier(0.32, 0.72, 0, 1), reduceMotion: ReduceMotion.System };

// Bottom sheet that replaces the stock Android dialog. Pass content to open, null to close.
// The chosen action runs after the close animation, so pickers don't launch over a closing modal.
export function Sheet({ content, onClose }: { content: SheetContent | null; onClose: () => void }) {
  const [s, t] = useStyles(styles);
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<SheetContent | null>(null); // keeps content on screen while closing
  const [h, setH] = useState(600);
  const p = useSharedValue(0);
  const after = useRef<(() => void) | undefined>(undefined);

  const closed = () => {
    setShown(null);
    const fn = after.current;
    after.current = undefined;
    fn?.();
  };

  useEffect(() => {
    if (content) {
      setShown(content);
      p.set(withTiming(1, SHEET));
    } else if (shown) {
      p.set(
        withTiming(0, { ...SHEET, duration: 240 }, (done) => {
          if (done) scheduleOnRN(closed);
        }),
      );
    }
  }, [content]);

  const backdrop = useAnimatedStyle(() => ({ opacity: p.get() }));
  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - p.get()) * h }] }));

  const close = (fn?: () => void) => {
    after.current = fn;
    onClose();
  };
  const cancel = () => close(shown?.onCancel);

  return (
    <Modal transparent visible={!!shown} animationType="none" onRequestClose={cancel} statusBarTranslucent navigationBarTranslucent>
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }, backdrop]}>
        <Pressable style={{ flex: 1 }} onPress={cancel} accessibilityLabel="Close" />
      </Animated.View>
      <Animated.View style={[s.sheet, { paddingBottom: insets.bottom + 16 }, panel]} onLayout={(e) => setH(e.nativeEvent.layout.height)}>
        <View style={s.handle} />
        {shown && (
          <>
            <View style={s.head}>
              <Text style={s.title} numberOfLines={1}>
                {shown.title}
              </Text>
              {shown.subtitle}
              {shown.message && <Text style={s.message}>{shown.message}</Text>}
            </View>
            {shown.extra}
            {shown.actions.length > 0 && (
              <View style={[s.group, shown.extra ? { marginTop: 20 } : null]}>
                {shown.actions.map((x, i) => (
                  <Press
                    key={x.label}
                    highlight={t.surface3}
                    style={[s.item, i > 0 && s.sep]}
                    onPress={() => {
                      haptic.select();
                      close(x.onPress);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={x.detail ? `${x.label}, ${x.detail}` : x.label}
                  >
                    {x.icon && (
                      <View style={[s.icon, { backgroundColor: x.destructive ? t.redSoft : t.accentSoft }]}>
                        <Ionicons name={x.icon} size={18} color={x.destructive ? t.red : t.onAccentSoft} />
                      </View>
                    )}
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={[s.label, x.destructive && { color: t.red }]}>{x.label}</Text>
                      {x.detail && (
                        <Text style={s.detail} numberOfLines={1}>
                          {x.detail}
                        </Text>
                      )}
                    </View>
                    {!x.destructive && <Ionicons name="chevron-forward" size={16} color={t.faint} />}
                  </Press>
                ))}
              </View>
            )}
            {/* settings close with "Done", questions with "Cancel"; both quiet grey so the rows stay the focus */}
            <Press style={s.close} onPress={cancel} accessibilityRole="button">
              <Text style={s.closeText}>{shown.extra ? 'Done' : 'Cancel'}</Text>
            </Press>
          </>
        )}
      </Animated.View>
    </Modal>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      paddingHorizontal: 16,
      paddingTop: 10,
      backgroundColor: t.surface,
      borderTopLeftRadius: 28,
      borderTopRightRadius: 28,
      borderCurve: 'continuous',
    },
    handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: t.line, marginBottom: 20 },
    head: { paddingHorizontal: 4, paddingBottom: 18, gap: 6 },
    title: { color: t.text, fontSize: 20, fontWeight: '700', letterSpacing: -0.4 },
    message: { color: t.dim, fontSize: 14, lineHeight: 20 },
    group: { backgroundColor: t.surface2, borderRadius: 18, borderCurve: 'continuous', overflow: 'hidden' },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      minHeight: 62,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: t.surface2,
    },
    sep: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: t.line },
    icon: { width: 36, height: 36, borderRadius: 11, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center' },
    label: { color: t.text, fontSize: 16, fontWeight: '600' },
    detail: { color: t.dim, fontSize: 13 },
    close: {
      height: 54,
      borderRadius: 16,
      borderCurve: 'continuous',
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 12,
      backgroundColor: t.surface2,
    },
    closeText: { color: t.text, fontSize: 16, fontWeight: '600' },
  });
