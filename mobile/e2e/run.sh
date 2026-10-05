#!/usr/bin/env bash
# Local end-to-end test on this Mac: fshare CLI + the app (Expo Go) in the iOS simulator, driven by Maestro.
# Needs: Xcode with an iOS simulator that has Expo Go installed, and `brew install mobile-dev-inc/tap/maestro`.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD
WORK=$(mktemp -d)
CLI_LOG=$WORK/cli.log
started_metro=""

cleanup() {
  [ -n "${CLI_PID:-}" ] && kill "$CLI_PID" 2>/dev/null || true
  [ -n "$started_metro" ] && kill "$METRO_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if lsof -iTCP:4747 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 4747 is in use (is fshare already running?). Quit it and try again." >&2
  exit 1
fi

# 1. something to share
mkdir -p "$WORK/share/photos" "$WORK/out"
echo "hello from the e2e test" > "$WORK/share/hello.txt"
head -c 300000 /dev/urandom > "$WORK/share/photos/a.jpg"
head -c 200000 /dev/urandom > "$WORK/share/photos/b.jpg"

# 2. the CLI (as the laptop)
node cli/fshare.ts -p 4747 -o "$WORK/out" "$WORK/share/hello.txt" "$WORK/share/photos" < /dev/null > "$CLI_LOG" 2>&1 &
CLI_PID=$!

# 3. a booted simulator
if ! xcrun simctl list devices booted | grep -q Booted; then
  DEVICE=$(xcrun simctl list devices available | grep -m1 -oE 'iPhone[^(]*\(([0-9A-F-]{36})\)' | grep -oE '[0-9A-F-]{36}')
  echo "Booting simulator $DEVICE"
  xcrun simctl boot "$DEVICE"
  sleep 10
fi

# 4. Metro (reuse one that's already running)
if ! curl -s http://127.0.0.1:8081/status | grep -q running; then
  (cd mobile && CI=1 npx expo start --port 8081 > "$WORK/metro.log" 2>&1) &
  METRO_PID=$!
  started_metro=1
  for _ in $(seq 60); do curl -s http://127.0.0.1:8081/status | grep -q running && break; sleep 1; done
fi

# 5. fresh app state: forget onboarding/pairing for this project inside Expo Go
DATA=$(xcrun simctl get_app_container booted host.exp.Exponent data 2>/dev/null || true)
if [ -z "$DATA" ]; then
  echo "Expo Go isn't installed on the booted simulator. Open the project once with 'npx expo start' and press i." >&2
  exit 1
fi
find "$DATA" -name '.fshare-prefs.json' -delete 2>/dev/null || true

# 6. drive the app
mkdir -p "$ROOT/e2e-output"
maestro test --env APP_URL=exp://127.0.0.1:8081 --test-output-dir "$ROOT/e2e-output" mobile/e2e/app.yaml

# 7. the CLI saw the real transfers
grep -q "Sent      hello.txt" "$CLI_LOG" || { echo "CLI never sent hello.txt" >&2; cat "$CLI_LOG"; exit 1; }
grep -q "Sent      photos/a.jpg" "$CLI_LOG" || { echo "CLI never sent photos/a.jpg" >&2; exit 1; }
grep -q "Unshared  photos/a.jpg" "$CLI_LOG" || { echo "CLI never unshared photos" >&2; exit 1; }
echo "✓ e2e passed"
