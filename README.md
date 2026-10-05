# fshare

Fast file transfer between laptop and phone, and phone to phone. Laptop runs a CLI, phones run an Expo app.

## Use it

1. Plug the phone into the laptop.
2. Run `fshare` (optionally with files/folders: `fshare ~/Movies/clip.mp4 ~/Photos/trip`).
3. Open the app. It connects by itself. With the installed APK it even opens by itself.

One-time: turn on **USB debugging** on the phone (Settings › About phone › tap "Build number" 7×,
then Developer options › USB debugging) and tap "Always allow" when you first plug in.
`fshare` downloads `adb` by itself if it isn't installed.

- Drag more files/folders into the terminal + Enter to share them.
- Files from the phone land in `~/Downloads` (`-o dir` to change).
- `x` + Enter cancels all transfers (partial files are deleted). `q` + Enter shows the Wi-Fi QR.
- `--new-pair` forgets paired phones.

### Without a cable

In the app tap "Use Wi-Fi instead", type `q` + Enter in the terminal and scan the QR.
After that the app also reconnects over Wi-Fi by itself.

### Phone to phone (installed Android app only)

- **Cable:** connect the two phones with a USB-C cable and open fshare on both. Allow the USB prompt
  ("Open fshare", tick "always"); they connect by themselves.
- **Wi-Fi:** both phones on the same Wi-Fi or hotspot, fshare open. Tap the other phone under
  "Nearby" (or in the device switcher at the top), accept on the other phone.
- Tap the device card at the top to switch between connected devices.

### Share sheet (installed Android app only)

In Gallery or any app: Share › fshare. The files go to the connected device (or send as soon as one connects).

## Setup

```sh
npx fshare-cli                                   # laptop, no install (Node >= 20.12)
cd cli && npm i && npm link                      # or from this repo
cd mobile && npm i
npx eas-cli build -p android --profile preview   # installable APK (recommended)
# or for development: npx expo start  → open in Expo Go
```

Received files save automatically: Android into a folder inside `Download` you pick once
(Android 11+ blocks the `Download` root itself); iOS into the app's folder in Files.

## How it works

Plain HTTP over the LAN. The laptop serves files and accepts `PUT` uploads; the phone uses
Expo's native download/upload tasks, so bytes never pass through JS. A random token in the
QR URL keeps other devices on the network out. Traffic is **not encrypted**, so use it on
networks you trust.

Speed tips: 5 GHz / Wi-Fi 6, laptop near the router (or wired to it), phone and laptop on the
same network band.

## Development

```sh
npm run setup      # install everything (root tools, cli/, mobile/)
npm run check      # what CI runs: format, lint, typecheck, unit + integration tests
npm run format     # fix formatting
npm run e2e        # end-to-end on this Mac (see below)
```

| Layer | What | Where |
| --- | --- | --- |
| Format | Prettier | `.prettierrc.json` |
| Lint | ESLint + typescript-eslint + React hooks | `eslint.config.mjs` |
| Types | `tsc` for `cli/` and `mobile/` | each `tsconfig.json` |
| CLI tests | `node --test`: HTTP server round-trips (resume, cancel, unshare), terminal UI, USB tunnel with a fake phone | `cli/*.test.ts` |
| App tests | Jest (`jest-expo`) + Testing Library: helpers and screens | `mobile/__tests__/` |
| E2E | Maestro drives the real app in the iOS simulator (Expo Go) against a real CLI: onboarding, connect, select/remove, download, settings, about | `mobile/e2e/` |
| Release tooling | version bump / versionCode math | `scripts/release.test.mjs` |

**E2E prerequisites** (one time): Xcode with an iOS simulator that has Expo Go (run `npx expo start` in
`mobile/` and press `i` once), and `brew install mobile-dev-inc/tap/maestro`. Port 4747 must be free
(quit any running `fshare`). `npm run e2e` starts the CLI with sample files, Metro if needed, resets the
app's saved state, runs `mobile/e2e/app.yaml`, and checks the CLI really sent and unshared the files.

**Android build locally:** `cd mobile && npx expo prebuild -p android && cd android && ./gradlew assembleRelease`
(needs JDK 17 and the Android SDK).

## CI/CD

- **`.github/workflows/ci.yml`** runs on every pull request and push to `main`:
  - checks (format, lint, types, tests, expo-doctor)
  - CLI tests on Node 22/24 (Linux and macOS) plus a packed-install smoke test
  - the CLI on Node 20
  - an Android APK build, uploaded as a workflow artifact
- `main` is protected: changes land through pull requests, and a PR can only merge once all checks pass.
- **`.github/workflows/release.yml`** runs on version tags (below).

## Versioning and releases

Both parts use semver and are released separately, each with its own tag.

```sh
npm run release -- cli patch    # 0.2.0 -> 0.2.1, commits and tags cli-v0.2.1
npm run release -- app minor    # 1.0.0 -> 1.1.0, tags app-v1.1.0
git push origin main <tag>      # CI publishes it
```

- **CLI** (`cli/package.json`): a `cli-v*` tag publishes `fshare-cli` to npm (needs the `NPM_TOKEN`
  repo secret) and creates a GitHub release.
- **App** (`mobile/app.json`): an `app-v*` tag builds the APK and attaches it to a GitHub release. The
  Android `versionCode` is derived from the version (`major*10000 + minor*100 + patch`, so 1.2.3 → 10203)
  and always increases. To sign with your own key instead of the debug key, add the secrets
  `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`.
