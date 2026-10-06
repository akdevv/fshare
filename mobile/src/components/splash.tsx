// Takes over from the native splash with the same picture, drawn as three layers (cookie, ↑, ↓)
// so the arrows can move on their own. They draw in together for a beat, then shoot apart, the up
// arrow up and the down arrow down, like a send and a receive. The screen lifts away as they go,
// and the app underneath settles into place. Reduced motion: a plain fade.
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import * as SplashScreen from 'expo-splash-screen';
import Animated, {
  Easing,
  makeMutable,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useTheme } from '../theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

const SIZE = 160; // app.json › expo-splash-screen › imageWidth
const OUT = Easing.bezier(0.23, 1, 0.32, 1);
const IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
const AWAY = Easing.bezier(0.5, 0, 0.75, 0); // picks up speed as it leaves
const rm = ReduceMotion.Never; // the reduced path below is already gentle

// 0 while the splash covers the app, 1 once it has settled in; the app's root (Behind) scales with it
export const appReveal = makeMutable(1);

const HOLD = 120; // ms on the still picture
const GATHER = 200; // arrows draw in
const FLY = 420; // arrows shoot apart
const LIFT = HOLD + GATHER + 160; // the screen starts lifting while they fly

export function Splash() {
  const t = useTheme();
  const reduced = useReducedMotion();
  const [gone, setGone] = useState(false);
  const shift = useSharedValue(0); // arrows: - toward each other, + apart
  const arrows = useSharedValue(1); // their opacity
  const body = useSharedValue(1); // cookie scale
  const fade = useSharedValue(1);

  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {}); // ours is on screen now, pixel for pixel
    const done = () => setGone(true);
    if (reduced) {
      fade.set(
        withDelay(
          150,
          withTiming(0, { duration: 250, reduceMotion: rm }, (ok) => ok && scheduleOnRN(done)),
        ),
      );
      return;
    }
    appReveal.set(0);
    shift.set(
      withDelay(
        HOLD,
        withSequence(
          withTiming(-5, { duration: GATHER, easing: IN_OUT, reduceMotion: rm }),
          withTiming(70, { duration: FLY, easing: AWAY, reduceMotion: rm }),
        ),
      ),
    );
    arrows.set(withDelay(HOLD + GATHER + 120, withTiming(0, { duration: FLY - 120, easing: AWAY, reduceMotion: rm })));
    body.set(
      withDelay(
        HOLD,
        withSequence(
          withTiming(0.95, { duration: GATHER, easing: IN_OUT, reduceMotion: rm }),
          withTiming(1.05, { duration: FLY, easing: OUT, reduceMotion: rm }),
        ),
      ),
    );
    fade.set(
      withDelay(
        LIFT,
        withTiming(0, { duration: 340, easing: OUT, reduceMotion: rm }, (ok) => ok && scheduleOnRN(done)),
      ),
    );
    appReveal.set(withDelay(LIFT, withTiming(1, { duration: 520, easing: OUT, reduceMotion: rm })));
  }, []);

  const backdrop = useAnimatedStyle(() => ({ opacity: fade.get() }));
  const cookie = useAnimatedStyle(() => ({ transform: [{ scale: body.get() }] }));
  const up = useAnimatedStyle(() => ({ opacity: arrows.get(), transform: [{ translateY: -shift.get() }] }));
  const down = useAnimatedStyle(() => ({ opacity: arrows.get(), transform: [{ translateY: shift.get() }] }));

  if (gone) return null;
  return (
    <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.center, { backgroundColor: t.bg }, backdrop]}>
      <View style={styles.box}>
        <Animated.Image source={require('../../assets/splash-cookie.png')} style={[styles.layer, cookie]} />
        <Animated.Image source={require('../../assets/splash-up.png')} style={[styles.layer, up]} />
        <Animated.Image source={require('../../assets/splash-down.png')} style={[styles.layer, down]} />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: 'center', justifyContent: 'center' },
  box: { width: SIZE, height: SIZE },
  layer: { position: 'absolute', width: SIZE, height: SIZE },
});
