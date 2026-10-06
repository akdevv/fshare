import type { ReactNode } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  cubicBezier,
  Easing,
  FadeIn,
  FadeInDown,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  SlideInRight,
  SlideOutRight,
} from 'react-native-reanimated';

// for withTiming and layout animations
export const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
export const EASE_SHEET = Easing.bezier(0.32, 0.72, 0, 1); // iOS's sheet and push curve
// for CSS transitions in styles
export const CSS_EASE_OUT = cubicBezier(0.23, 1, 0.32, 1);

const reduce = ReduceMotion.System;

// list rows and cards: fade in, fade out, and the rest of the list glides into place
export const ENTER = FadeIn.duration(220).easing(EASE_OUT).reduceMotion(reduce);
export const EXIT = FadeOut.duration(160).reduceMotion(reduce);
export const LAYOUT = LinearTransition.duration(240)
  .easing(Easing.bezier(0.77, 0, 0.175, 1))
  .reduceMotion(reduce);

// a gentle fade-up on first appearance; screens stagger their sections with `delay`
export const rise = (delay: number, distance = 10, duration = 420) =>
  FadeInDown.delay(delay)
    .duration(duration)
    .easing(EASE_OUT)
    .withInitialValues({ transform: [{ translateY: distance }] })
    .reduceMotion(reduce);

// A screen pushed over the main one: slides in from the right while `open`, and back out.
export function Pushed({ open, children }: { open: boolean; children: ReactNode }) {
  if (!open) return null;
  return (
    <Animated.View
      entering={SlideInRight.duration(340).easing(EASE_SHEET).reduceMotion(reduce)}
      exiting={SlideOutRight.duration(260).easing(EASE_SHEET).reduceMotion(reduce)}
      style={StyleSheet.absoluteFill}
    >
      {children}
    </Animated.View>
  );
}
