// iOS 27 stops apps at launch unless they use the scene life cycle. Expo ships the scene delegate
// (ExpoAppSceneDelegate) but SDK 57's template doesn't use it yet, so: register it in Info.plist and
// let it start React Native in its window instead of the app delegate.
// ponytail: drop this once `npx expo prebuild` generates a scene-based AppDelegate itself.
const { withAppDelegate, withInfoPlist } = require('expo/config-plugins');

module.exports = (config) => {
  config = withInfoPlist(config, (c) => {
    c.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: false,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          { UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: 'EXExpoAppSceneDelegate' },
        ],
      },
    };
    return c;
  });
  return withAppDelegate(config, (c) => {
    let s = c.modResults.contents;
    if (s.includes('ExpoReactNativeFactoryProvider')) return c;
    s = s.replace('class AppDelegate: ExpoAppDelegate {', 'class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {');
    // the scene delegate makes the window and starts React Native in it
    s = s.replace(/#if os\(iOS\) \|\| os\(tvOS\)\n\s*window = UIWindow[\s\S]*?#endif\n/, '');
    if (!s.includes('ExpoReactNativeFactoryProvider {') || s.includes('startReactNative(')) {
      throw new Error('with-scene-lifecycle: AppDelegate.swift changed shape; update the plugin');
    }
    c.modResults.contents = s;
    return c;
  });
};
