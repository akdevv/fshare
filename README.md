# fshare

Fast file transfer between laptop and phone, and phone to phone. Laptop runs a CLI, phones run an Expo app.

## Install the CLI

```sh
curl -fsSL https://raw.githubusercontent.com/akdevv/fshare/main/install.sh | sh
```

Needs git and Node.js 20.12+. It downloads fshare into `~/.fshare`, builds it, and puts `fshare` on
your PATH. `fshare update` gets the latest version; `fshare uninstall` removes it (your pairing stays
in `~/.config/fshare`).

## Use it

1. Plug the phone into the laptop.
2. Run `fshare` (optionally with files/folders: `fshare ~/Movies/clip.mp4 ~/Photos/trip`).
3. Open the app. It connects by itself. With the installed APK it even opens by itself.

One-time: turn on **USB debugging** on the phone (Settings › About phone › tap "Build number" 7×,
then Developer options › USB debugging) and tap "Always allow" when you first plug in.
`fshare` downloads `adb` by itself if it isn't installed.

- `fshare send photo.jpg docs/` from any terminal sends to the phone through the fshare that's
  already running (or starts one).
- Or drag files/folders into the fshare window + Enter.
- Files from the phone land in `~/Downloads` (`-o dir` to change), with a notification. `o` opens
  that folder.
- `x` cancels all transfers (partial files are deleted). `q` shows the Wi-Fi QR.
- `--new-pair` forgets paired phones. `fshare help` lists everything.

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
cd cli && npm i && node fshare.ts                # the CLI from this repo
cd mobile && npm i
npx eas-cli build -p android --profile preview   # installable APK (recommended)
# or for development: npx expo start  → open in Expo Go
```

Received files save automatically: Android into a folder inside `Download` you pick once
(Android 11+ blocks the `Download` root itself); iOS into the app's folder in Files.

## How it works

HTTP over the LAN, encrypted end to end. The laptop serves files and accepts `PUT` uploads;
the phone uses Expo's native download/upload tasks, so bytes never pass through JS.

- **Pairing.** A random token reaches the phone through the QR code or the USB cable, never over
  Wi-Fi. Two phones pair with an ECDH key exchange and show the same 6-digit code to compare.
- **Requests** are signed with the token (HMAC-SHA256), so nobody else on the network can list,
  download, upload or delete anything.
- **Everything is sealed** with AES-256-GCM: file contents (in 64 KB chunks, so paused transfers
  still resume), file names, the shared-file list and device names. A file that was cut short or
  changed on the way is refused, not saved.

The spec is at the top of [`cli/seal.ts`](cli/seal.ts); the app's `Seal.kt` and `Seal.swift`
follow it byte for byte.

Speed tips: 5 GHz / Wi-Fi 6, laptop near the router (or wired to it), phone and laptop on the
same network band.

## Development

```sh
npm run setup      # install everything (root tools, cli/, mobile/)
npm run check      # what CI runs: format, lint, typecheck, unit + integration tests
npm run format     # fix formatting
npm run e2e        # end-to-end on this Mac (see below)
npm run test:native  # the app's Android and iOS peer servers, built outside the app and driven from Node
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

**APK (local only):** `npm run apk` builds `dist/fshare-<version>.apk` (a few minutes; needs JDK 17 and
the Android SDK: `brew install openjdk@17 && brew install --cask android-commandlinetools`). APKs aren't
built in CI. Build one before merging app changes you want to try on a phone.

## CI/CD

- **`.github/workflows/ci.yml`** runs on every pull request and push to `main`, in a few minutes:
  - checks (format, lint, types, tests, expo-doctor)
  - CLI tests on Node 22/24 (Linux and macOS), plus `install.sh` installing and uninstalling it
  - the CLI on Node 20
- `main` is protected, including for admins: changes land through pull requests, and a PR can only
  merge once all checks pass and it's up to date with `main`.
- **`.github/workflows/release.yml`** tests the CLI and makes its GitHub release when a `cli-v*` tag is pushed.

## Versioning and releases

Both parts use semver and are released separately, each with its own tag. Because `main` is protected,
a release is two steps:

```sh
npm run release -- app minor        # 1. bump on a release branch and open a PR (CI checks it)
                                    #    ...merge the PR...
npm run release:publish -- app      # 2. on main: tag it and publish
```

- **CLI** (`cli/package.json`): publishing pushes `cli-vX.Y.Z`, and CI creates the GitHub release.
  It isn't on npm: `install.sh` and `fshare update` install whatever is on `main`.
- **App** (`mobile/app.json`): publishing builds the APK on your Mac, pushes `app-vX.Y.Z`, and creates
  the GitHub release with the APK attached. The Android `versionCode` is derived from the version
  (`major*10000 + minor*100 + patch`, so 1.2.3 → 10203) and always increases. To sign with your own
  key instead of the debug key, set `FSHARE_KEYSTORE`, `FSHARE_KEYSTORE_PASSWORD`, `FSHARE_KEY_ALIAS`
  and `FSHARE_KEY_PASSWORD` before publishing.
