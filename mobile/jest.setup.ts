// Unit tests run without native code: Reanimated in test mode, settings kept in memory.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  // newer APIs the bundled mock doesn't cover; animations don't run in tests anyway
  cubicBezier: () => 'ease-out',
  useReducedMotion: () => true,
  Keyframe: class {
    duration() {
      return this;
    }
    reduceMotion() {
      return this;
    }
  },
}));

jest.mock('./prefs', () => {
  let prefs = {};
  return {
    readPrefs: () => prefs,
    writePrefs: (p: object) => (prefs = { ...prefs, ...p }),
  };
});
