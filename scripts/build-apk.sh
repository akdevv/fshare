#!/usr/bin/env bash
# Build the release APK on this Mac: dist/fshare-<version>.apk
# Needs JDK 17 and the Android SDK (`brew install openjdk@17 --cask android-commandlinetools`, see README).
# APK builds don't run in CI (they take 10+ minutes there); run this before merging app changes
# you want to try on a phone, and `npm run release:publish -- app` uses it for APK releases.
set -euo pipefail
cd "$(dirname "$0")/.."

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_HOME=$(/usr/libexec/java_home -v 17 2>/dev/null || true)
  [ -z "$JAVA_HOME" ] && [ -d /opt/homebrew/opt/openjdk@17 ] && JAVA_HOME=/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home
  export JAVA_HOME
fi
[ -d "$ANDROID_HOME" ] || { echo "Android SDK not found at $ANDROID_HOME (set ANDROID_HOME)" >&2; exit 1; }
[ -n "$JAVA_HOME" ] || { echo "JDK 17 not found (set JAVA_HOME)" >&2; exit 1; }

VERSION=$(node -p 'require("./mobile/app.json").expo.version')
# arm64 only (every phone from the last ~8 years); add armeabi-v7a,x86_64 if someone needs them
ABIS="${ABIS:-arm64-v8a}"

(cd mobile && CI=1 npx expo prebuild -p android --no-install > /dev/null)
(cd mobile/android && ./gradlew assembleRelease -PreactNativeArchitectures="$ABIS" --console=plain -q)

mkdir -p dist
cp mobile/android/app/build/outputs/apk/release/app-release.apk "dist/fshare-$VERSION.apk"
echo "✓ dist/fshare-$VERSION.apk ($(du -h "dist/fshare-$VERSION.apk" | cut -f1))"
