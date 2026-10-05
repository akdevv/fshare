// Shared building blocks. Motion runs on Reanimated (UI thread) and respects reduced-motion.
import { useEffect, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  cubicBezier,
  Easing,
  FadeIn,
  Keyframe,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Path } from 'react-native-svg';
import { haptic, useStyles, useThemePref, type Theme, type ThemePref } from './theme';

export const EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

// Press feedback on press-in. Buttons scale to 0.97; list rows ("highlight") tint instead,
// since a whole row shrinking reads as the screen squishing.
export function Press({
  style,
  children,
  highlight,
  grow,
  ...rest
}: Omit<PressableProps, 'style' | 'children'> & {
  style?: StyleProp<ViewStyle>;
  children?: ReactNode;
  highlight?: string;
  grow?: boolean;
}) {
  const [down, setDown] = useState(false);
  const reduced = useReducedMotion();
  const pressable = !!rest.onPress && !rest.disabled;
  return (
    <Pressable
      {...rest}
      style={grow && { flex: 1 }}
      pressRetentionOffset={12}
      onPressIn={(e) => {
        setDown(true);
        rest.onPressIn?.(e);
      }}
      onPressOut={(e) => {
        setDown(false);
        rest.onPressOut?.(e);
      }}
    >
      <Animated.View
        style={[
          style,
          { opacity: rest.disabled ? 0.4 : 1 },
          highlight
            ? { transitionProperty: ['backgroundColor', 'opacity'], transitionDuration: 150 }
            : {
                transitionProperty: ['transform', 'opacity'],
                transitionDuration: 150,
                transitionTimingFunction: EASE_OUT,
                transform: [{ scale: down && pressable && !reduced ? 0.97 : 1 }],
              },
          highlight && down && pressable && { backgroundColor: highlight },
        ]}
      >
        {children}
      </Animated.View>
    </Pressable>
  );
}

// Wrap content whose identity changes (an icon, a status line): the new one pops/fades in softly.
const POP = new Keyframe({
  0: { opacity: 0, transform: [{ scale: 0.86 }] },
  100: { opacity: 1, transform: [{ scale: 1 }], easing: Easing.bezier(0.23, 1, 0.32, 1) },
})
  .duration(220)
  .reduceMotion(ReduceMotion.System);
const FADE = FadeIn.duration(200).reduceMotion(ReduceMotion.System);

export function Pop({ id, children, fade }: { id: string; children: ReactNode; fade?: boolean }) {
  return (
    <Animated.View key={id} entering={fade ? FADE : POP}>
      {children}
    </Animated.View>
  );
}

// Thin progress bar; the fill eases to each new value instead of jumping.
export function Bar({ f, color, track, height = 6 }: { f: number; color: string; track: string; height?: number }) {
  return (
    <View style={{ height, borderRadius: height / 2, backgroundColor: track, overflow: 'hidden' }}>
      <Animated.View
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          bottom: 0,
          borderRadius: height / 2,
          backgroundColor: color,
          width: `${Math.max(0, Math.min(1, f)) * 100}%`,
          transitionProperty: ['width', 'backgroundColor'],
          transitionDuration: 300,
          transitionTimingFunction: 'linear',
        }}
      />
    </View>
  );
}

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

// Progress ring around a row's icon.
export function Ring({
  f,
  color,
  track,
  size = 44,
  stroke = 3,
}: {
  f: number;
  color: string;
  track: string;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const p = useSharedValue(f);
  useEffect(() => {
    p.set(withTiming(Math.min(1, f), { duration: 300, easing: Easing.linear }));
  }, [f]);
  const props = useAnimatedProps(() => ({ strokeDashoffset: c * (1 - p.get()) }));
  return (
    <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
      <Circle cx={size / 2} cy={size / 2} r={r} stroke={track} strokeWidth={stroke} fill="none" />
      <AnimatedCircle
        cx={size / 2}
        cy={size / 2}
        r={r}
        stroke={color}
        strokeWidth={stroke}
        fill="none"
        strokeDasharray={`${c} ${c}`}
        strokeLinecap="round"
        rotation={-90}
        origin={`${size / 2}, ${size / 2}`}
        animatedProps={props}
      />
    </Svg>
  );
}

// Scalloped M3 "cookie" shape. `spin` slowly rotates the shape (not its children);
// `outline` draws just the edge (used for ripples).
export function Cookie({
  size,
  color,
  children,
  spin,
  outline,
}: {
  size: number;
  color: string;
  children?: ReactNode;
  spin?: number;
  outline?: boolean;
}) {
  const reduced = useReducedMotion();
  const c = size / 2,
    R = size * (outline ? 0.45 : 0.46),
    n = 9,
    a = 0.07;
  const d =
    Array.from({ length: 121 }, (_, i) => {
      const th = (i / 120) * Math.PI * 2;
      const r = R * (1 + a * Math.cos(n * th));
      return `${i ? 'L' : 'M'}${(c + r * Math.cos(th)).toFixed(2)},${(c + r * Math.sin(th)).toFixed(2)}`;
    }).join(' ') + 'Z';
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          !!spin &&
            !reduced && {
              animationName: { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } },
              animationDuration: `${spin}s`,
              animationIterationCount: 'infinite',
              animationTimingFunction: 'linear',
            },
        ]}
      >
        <Svg width={size} height={size}>
          <Path d={d} fill={outline ? 'none' : color} stroke={outline ? color : undefined} strokeWidth={outline ? 1.5 : 0} />
        </Svg>
      </Animated.View>
      {children}
    </View>
  );
}

// System / Light / Dark segmented control with a sliding selection.
export function ThemeToggle() {
  const [s, t] = useStyles(styles);
  const { pref, setPref } = useThemePref();
  const [w, setW] = useState(0);
  const options: { value: ThemePref; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { value: 'system', label: 'System', icon: 'contrast-outline' },
    { value: 'light', label: 'Light', icon: 'sunny-outline' },
    { value: 'dark', label: 'Dark', icon: 'moon-outline' },
  ];
  const seg = (w - 8) / options.length;
  const index = options.findIndex((o) => o.value === pref);
  return (
    <View style={{ gap: 10 }}>
      <Text style={s.label}>Appearance</Text>
      <View style={s.track} onLayout={(e) => setW(e.nativeEvent.layout.width)} accessibilityRole="radiogroup">
        {w > 0 && (
          <Animated.View
            style={[
              s.thumb,
              {
                width: seg,
                transform: [{ translateX: index * seg }],
                transitionProperty: 'transform',
                transitionDuration: 240,
                transitionTimingFunction: EASE_OUT,
              },
            ]}
          />
        )}
        {options.map((o) => {
          const on = pref === o.value;
          return (
            <Pressable
              key={o.value}
              style={s.seg}
              onPress={() => {
                if (!on) {
                  haptic.select();
                  setPref(o.value);
                }
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on }}
              accessibilityLabel={o.label}
            >
              <Ionicons name={o.icon} size={17} color={on ? t.text : t.dim} />
              <Text style={[s.segText, on && s.segTextOn]}>{o.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = (t: Theme) =>
  StyleSheet.create({
    label: { color: t.dim, fontSize: 14, fontWeight: '600', paddingHorizontal: 4 },
    track: { flexDirection: 'row', height: 52, padding: 4, borderRadius: 16, borderCurve: 'continuous', backgroundColor: t.surface2 },
    thumb: {
      position: 'absolute',
      top: 4,
      bottom: 4,
      left: 4,
      borderRadius: 12,
      borderCurve: 'continuous',
      backgroundColor: t.scheme === 'dark' ? t.surface3 : t.surface,
      boxShadow: t.scheme === 'dark' ? '0 1px 2px rgba(0,0,0,0.5)' : '0 1px 3px rgba(0,0,0,0.12)',
    },
    seg: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
    segText: { color: t.dim, fontSize: 14, fontWeight: '500' },
    segTextOn: { color: t.text, fontWeight: '700' },
  });
