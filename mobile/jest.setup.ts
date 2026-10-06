// Unit tests run without native code: Reanimated in test mode, settings kept in memory.
jest.mock('react-native-worklets', () => require('react-native-worklets/lib/module/mock'));
jest.mock('react-native-reanimated', () => ({
  ...require('react-native-reanimated/mock'),
  // newer APIs the bundled mock doesn't cover; animations don't run in tests anyway
  cubicBezier: () => 'ease-out',
  // animated styles aren't under test; the mock would run the worklets with stub easings
  useAnimatedStyle: () => ({}),
  useAnimatedProps: () => ({}),
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

require('react-native-gesture-handler/jestSetup');

jest.mock('./src/lib/prefs', () => {
  let prefs = {};
  return {
    readPrefs: () => prefs,
    writePrefs: (p: object) => (prefs = { ...prefs, ...p }),
  };
});

jest.mock('expo-notifications', () => ({
  AndroidImportance: { DEFAULT: 3 },
  setNotificationChannelAsync: async () => {},
  requestPermissionsAsync: async () => ({}),
  scheduleNotificationAsync: async () => '',
}));

jest.mock('expo-crypto', () => ({ randomUUID: () => require('crypto').randomUUID() }));
