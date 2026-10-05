import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from 'react-native';
import Animated, {
  Easing,
  makeMutable,
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Gesture, GestureDetector, GestureHandlerRootView, ScrollView as GHScrollView } from 'react-native-gesture-handler';
import { scheduleOnRN } from 'react-native-worklets';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { haptic, useStyles, type Theme } from './theme';
import { Press } from './ui';
import { appReveal } from './splash';

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
  extra?: ReactNode; // live content (e.g. the theme switch), rendered above the actions; scrolls when tall
  footer?: ReactNode; // stays below `extra` even when that scrolls
  actions: SheetAction[];
  onCancel?: () => void;
  closeLabel?: string; // the bottom button; defaults to Done (with `extra`) or Cancel
};

// Vaul's drawer curve and timing (github.com/emilkowalski/vaul)
const SHEET = { duration: 500, easing: Easing.bezier(0.32, 0.72, 0, 1), reduceMotion: ReduceMotion.System };

// How open the frontmost sheet is, 0..1, following the finger while dragged. The screen behind
// reads it to sink back (Behind), like vaul's scaled background.
export const sheetProgress = makeMutable(0);

// Wraps the app screen: shrinks a little, drops, and rounds its corners while a sheet is up.
export function Behind({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const sink = useAnimatedStyle(() => {
    const p = reduced ? 0 : sheetProgress.get();
    const settle = 0.96 + 0.04 * appReveal.get(); // grows into place as the splash lifts
    return {
      borderRadius: p * 24,
      transform: [{ translateY: p * (insets.top > 20 ? 14 : 8) }, { scale: (1 - (p * 24) / width) * settle }],
    };
  });
  return <Animated.View style={[{ flex: 1, overflow: 'hidden', borderCurve: 'continuous' }, style, sink]}>{children}</Animated.View>;
}

const OVER = 80; // sheet height hidden below the screen

// pulled past where it can go: moves less and less the further you pull (vaul's damping)
const damp = (d: number) => {
  'worklet';
  return 8 * (Math.log(d + 1) - 2) > 0 ? 8 * (Math.log(d + 1) - 2) : d * 0.3;
};

// Bottom sheet that replaces the stock Android dialog. Pass content to open, null to close.
// The chosen action runs after the close animation, so pickers don't launch over a closing modal.
export function Sheet({ content, onClose }: { content: SheetContent | null; onClose: () => void }) {
  const [s, t] = useStyles(styles);
  const insets = useSafeAreaInsets();
  const [shown, setShown] = useState<SheetContent | null>(null); // keeps content on screen while closing
  const { height: screen } = useWindowDimensions();
  const box = useSharedValue(0); // visible height of the `extra` list
  const inner = useSharedValue(0); // its full content height
  const drag = useSharedValue(0); // px the finger has pulled the sheet down (negative: up, damped)
  const scrollY = useSharedValue(0);
  const from = useSharedValue(0); // finger travel spent scrolling the list before the sheet moves
  const sheetH = useSharedValue(screen); // measured on layout; starts off-screen
  const waiting = useRef(false); // opened, but not measured yet
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
      drag.set(0);
      // first open: wait for the layout so the slide starts from the sheet's real height
      if (shown) p.set(withTiming(1, SHEET));
      else waiting.current = true;
      setShown(content);
    } else if (shown) {
      // dragged partway already: finish the rest of the way down in proportion
      waiting.current = false;
      p.set(
        withTiming(0, { ...SHEET, duration: 380 }, (done) => {
          if (done) {
            drag.set(0);
            scheduleOnRN(closed);
          }
        }),
      );
    }
  }, [content]);

  // 1 = fully open; dragging down eats into it, so the backdrop and the screen behind follow the finger
  const open = () => {
    'worklet';
    return p.get() * (1 - Math.min(Math.max(drag.get(), 0) / sheetH.get(), 1));
  };
  useAnimatedReaction(open, (v) => sheetProgress.set(v));

  // the slide's curve front-loads; the dim eases in (smoothstep) so it settles rather than snaps on
  const backdrop = useAnimatedStyle(() => {
    const v = open();
    return { opacity: v * v * (3 - 2 * v) };
  });
  const panel = useAnimatedStyle(() => ({ transform: [{ translateY: (1 - p.get()) * sheetH.get() + drag.get() }] }));

  const onScroll = useAnimatedScrollHandler((e) => scrollY.set(e.contentOffset.y));
  // soft edges only where there's more to scroll to
  const fade = (on: boolean) => {
    'worklet';
    return withTiming(on ? 1 : 0, { duration: 150 });
  };
  const topFade = useAnimatedStyle(() => ({ opacity: fade(scrollY.get() > 2) }));
  const bottomFade = useAnimatedStyle(() => ({ opacity: fade(inner.get() - box.get() - scrollY.get() > 2) }));
  // made once: a gesture rebuilt every render re-registers its worklets, and an event arriving
  // mid-swap (e.g. as the sheet closes) crashed the UI runtime
  const dismiss = useRef(() => {});
  const { native, pan } = useMemo(() => {
    const requestDismiss = () => dismiss.current(); // a plain JS function, so the worklet can call it back
    const native = Gesture.Native();
    // drag anywhere on the sheet; inside a scrolled list, the list scrolls first and the sheet
    // takes over once it's back at the top. A flick closes it; a slow short pull springs back.
    const pan = Gesture.Pan()
      .activeOffsetY([-8, 8])
      .simultaneousWithExternalGesture(native)
      .onStart(() => from.set(0))
      .onUpdate((e) => {
        if (scrollY.get() > 0.5) return from.set(e.translationY);
        const d = e.translationY - from.get();
        if (d >= 0) drag.set(d);
        else drag.set(inner.get() > box.get() + 1 ? 0 : -damp(-d)); // a long list scrolls up instead
      })
      .onEnd((e) => {
        const d = drag.get();
        if (d > 0 && (e.velocityY > 600 || d > sheetH.get() * 0.3)) scheduleOnRN(requestDismiss);
        else drag.set(withTiming(0, SHEET));
      });
    return { native, pan };
  }, []);

  const close = (fn?: () => void) => {
    after.current = fn;
    onClose();
  };
  const cancel = () => close(shown?.onCancel);
  dismiss.current = cancel;

  return (
    <Modal transparent visible={!!shown} animationType="none" onRequestClose={cancel} statusBarTranslucent navigationBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: t.backdrop }, backdrop]}>
          <Pressable style={{ flex: 1 }} onPress={cancel} accessibilityLabel="Close" />
        </Animated.View>
        <GestureDetector gesture={pan}>
          <Animated.View
            // runs past the bottom edge so a pull upward never shows a gap under it
            style={[s.sheet, { paddingBottom: insets.bottom + 16 + OVER, marginBottom: -OVER }, panel]}
            onLayout={(e) => {
              sheetH.set(e.nativeEvent.layout.height - OVER);
              if (!waiting.current) return;
              waiting.current = false;
              p.set(withTiming(1, SHEET));
            }}
          >
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
                {shown.extra && (
                  <View>
                    <GestureDetector gesture={native}>
                      <AScroll
                        style={{ maxHeight: screen * 0.55 }}
                        showsVerticalScrollIndicator={false}
                        bounces={false}
                        overScrollMode="never"
                        scrollEventThrottle={16}
                        onLayout={(e) => box.set(e.nativeEvent.layout.height)}
                        onContentSizeChange={(_, ch) => inner.set(ch)}
                        onScroll={onScroll}
                      >
                        {shown.extra}
                      </AScroll>
                    </GestureDetector>
                    <Fade at="top" style={topFade} color={t.surface} />
                    <Fade at="bottom" style={bottomFade} color={t.surface} />
                  </View>
                )}
                {shown.footer && <View style={{ marginTop: 12 }}>{shown.footer}</View>}
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
                  <Text style={s.closeText}>{shown.closeLabel ?? (shown.extra ? 'Done' : 'Cancel')}</Text>
                </Press>
              </>
            )}
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
  );
}

const AScroll = Animated.createAnimatedComponent(GHScrollView);

function Fade({ at, style, color }: { at: 'top' | 'bottom'; style: object; color: string }) {
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: 'absolute',
          left: 0,
          right: 0,
          height: 28,
          [at]: 0,
          experimental_backgroundImage: `linear-gradient(to ${at}, ${color}00, ${color})`,
        },
        style,
      ]}
    />
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
