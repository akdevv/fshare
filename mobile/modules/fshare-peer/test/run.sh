#!/usr/bin/env bash
# Builds the app's peer servers outside the app (Kotlin on a plain JVM, Swift on this Mac) and
# drives each with drive.mts. Needs a JDK, the Kotlin compiler from a past Android build's Gradle
# cache, and swiftc (macOS). Whatever's missing is skipped.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/.."
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
status=0

c="$HOME/.gradle/caches/modules-2/files-2.1"
jar() { find "$c/$1" -name "*.jar" ! -name "*-sources.jar" 2>/dev/null | sort -V | tail -1; }
kc=$(jar org.jetbrains.kotlin/kotlin-compiler-embeddable)
if command -v javac >/dev/null && [ -n "$kc" ]; then
  echo "Android (Kotlin on the JVM)"
  std=$(jar org.jetbrains.kotlin/kotlin-stdlib)
  cp="$kc:$std:$(jar org.jetbrains.kotlin/kotlin-script-runtime):$(jar org.jetbrains.kotlin/kotlin-reflect):$(jar org.jetbrains.kotlin/kotlin-daemon-embeddable):$(jar org.jetbrains.intellij.deps/trove4j):$(jar org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm):$(jar org.jetbrains/annotations)"
  mkdir -p "$work/kt" "$work/a"
  javac -d "$work/kt" $(find "$here/stubs" -name "*.java")
  kt="$src/android/src/main/java/expo/modules/fsharepeer"
  java -cp "$cp" org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -nowarn -cp "$std:$work/kt" -d "$work/kt" \
    "$kt/Seal.kt" "$kt/PeerServer.kt" "$here/PeerMain.kt"
  node "$here/drive.mts" "$work/a" 47998 java -cp "$std:$work/kt" PeerMainKt || status=1
else
  echo "Android: skipped (needs a JDK and a Gradle cache from an Android build)"
fi

if command -v swiftc >/dev/null; then
  echo "iOS (Swift on this Mac)"
  mkdir -p "$work/i"
  cp "$here/PeerMain.swift" "$work/main.swift" # top-level code only runs from main.swift
  swiftc -O -suppress-warnings -o "$work/peer" "$src/ios/Seal.swift" "$src/ios/PeerServer.swift" "$work/main.swift"
  node "$here/drive.mts" "$work/i" 47999 "$work/peer" || status=1
else
  echo "iOS: skipped (needs swiftc)"
fi
exit $status
