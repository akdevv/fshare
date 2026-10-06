# fshare

Send files between your laptop and your Android phone, or between two phones, over a USB cable or
your Wi-Fi. Files go straight across, encrypted end to end, and never touch the internet. No
accounts, no cloud, no file size limits.

[![CI](https://github.com/akdevv/fshare/actions/workflows/ci.yml/badge.svg)](https://github.com/akdevv/fshare/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

## Install

**Laptop** (macOS or Linux, needs git and [Node.js](https://nodejs.org) 20.12+):

```sh
curl -fsSL https://raw.githubusercontent.com/akdevv/fshare/main/install.sh | sh
```

`fshare update` gets the latest version and `fshare uninstall` removes it.

**Android phone:** [download the app (fshare.apk)](https://github.com/akdevv/fshare/releases/latest/download/fshare.apk),
open it, and allow installing from your browser when Android asks. Every version is on the
[releases page](https://github.com/akdevv/fshare/releases).

## Use it

### Over a USB cable

1. Run `fshare` on the laptop.
2. Plug in the phone and open the app. It connects by itself.

The first time, turn on **USB debugging** on the phone (Settings › About phone › tap "Build number"
7 times, then Developer options › USB debugging) and tap "Always allow". `fshare` downloads `adb`
itself if you don't have it.

### Over Wi-Fi

Put both on the same network, press `q` in fshare on the laptop, and scan the QR code from the app.
After that the phone reconnects over Wi-Fi by itself.

### Sending files

| From | How |
| --- | --- |
| Laptop | `fshare send photo.jpg docs/` from any terminal, or drop files into the fshare window and press Enter |
| Phone | **Send files** in the app, or Share › fshare from the Gallery or any other app |

Files from the phone land in `~/Downloads` with a notification (`fshare -o <dir>` to change; `o`
opens the folder). On the phone, you pick a save folder once.

### Phone to phone

- **Wi-Fi:** both phones on the same Wi-Fi or hotspot with fshare open. Tap the other phone under
  Nearby, check that both screens show the same 6-digit code, and accept on the other phone.
- **Cable:** connect the phones with a USB-C cable and open fshare on both. Allow the USB prompt
  ("Open fshare", tick "always").

### Commands

| Command | What it does |
| --- | --- |
| `fshare [files…]` | Start, and send these to your phone |
| `fshare send <files…>` | Send from any terminal (starts fshare if it isn't running) |
| `fshare update` | Get the latest version from GitHub |
| `fshare uninstall` | Remove fshare (your pairing stays in `~/.config/fshare`) |
| `fshare --new-pair` | Forget paired phones; they scan the QR code again |
| `fshare help` | Everything else |

While it runs: `o` opens the received-files folder, `q` shows the Wi-Fi QR code, and `x` cancels all
transfers.

## Privacy and security

Nothing leaves your network, and nobody else on it can read or touch your files:

- **Pairing.** The key reaches the phone through the QR code or the USB cable, never over Wi-Fi.
  Two phones pair with an ECDH key exchange and show the same 6-digit code to compare, so nobody
  can sit in between.
- **Every request is signed** (HMAC-SHA256), so other devices can't list, download, upload or
  delete anything.
- **Everything is encrypted** with AES-256-GCM: file contents, file names, the file list and device
  names. Files go in 64 KB chunks, so paused transfers still resume, and a file that was cut short
  or changed on the way is refused, not saved.

The spec is at the top of [`cli/seal.ts`](cli/seal.ts). The app's `Seal.kt` and `Seal.swift`
follow it byte for byte, and `npm run test:native` checks that they agree.

For speed: 5 GHz or Wi-Fi 6, with the laptop near the router (or wired to it). A USB cable is
fastest.

## How it's built

- **`cli/`**: the laptop side, a Node.js HTTP server with a terminal UI. It also talks to Android
  phones over USB (adb, or Android Open Accessory when USB debugging is off).
- **`mobile/`**: the phone app, built with Expo and React Native. A native module
  (`modules/fshare-peer`, Kotlin and Swift) runs the phone's own server, Wi-Fi discovery, the
  USB-C link between phones and the encryption.

## Development

```sh
npm run setup        # install everything (root tools, cli/, mobile/)
npm run check        # what CI runs: format, lint, typecheck, unit and integration tests
npm run format       # fix formatting
npm run test:native  # the app's Android and iOS peer servers, built outside the app and driven from Node
npm run apk          # build dist/fshare-<version>.apk on this Mac
cd cli && node fshare.ts   # run the CLI from the repo
```

| Layer | What | Where |
| --- | --- | --- |
| Format | Prettier | `.prettierrc.json` |
| Lint | ESLint, typescript-eslint, React hooks | `eslint.config.mjs` |
| Types | `tsc` for `cli/` and `mobile/` | each `tsconfig.json` |
| CLI tests | `node --test`: the HTTP server (resume, cancel, tampering), encryption, terminal UI, USB tunnel with a fake phone | `cli/*.test.ts` |
| App tests | Jest (`jest-expo`) and Testing Library: helpers and screens | `mobile/__tests__/` |
| Phone servers | Kotlin and Swift peer servers driven from Node (`npm run test:native`, not in CI) | `mobile/modules/fshare-peer/test/` |
| Release tooling | version bump and versionCode math | `scripts/release.test.mjs` |

Building the APK takes a few minutes and needs JDK 17 and the Android SDK
(`brew install openjdk@17 && brew install --cask android-commandlinetools`). It isn't built in CI.

### CI

- **`ci.yml`** runs once per pull request: format, lint, types, tests and expo-doctor; the CLI on
  Node 20, 22 and 24 (Linux and macOS); and `install.sh` installing and uninstalling it.
- `main` is protected: changes land through pull requests that are up to date with `main` and pass
  CI, so it doesn't run again after a merge.
- **`release.yml`** tests the CLI and makes its GitHub release when a `cli-v*` tag is pushed.

### Releases

Both parts use semver and are released separately. Because `main` is protected, a release is two
steps:

```sh
npm run release -- app minor     # 1. bump on a release branch and open a PR
                                 #    ...merge the PR...
npm run release:publish -- app   # 2. on main: tag it and publish
```

- **App** (`mobile/app.json`): publishing builds the APK, pushes `app-vX.Y.Z`, and makes the GitHub
  release with the APK attached as `fshare.apk`. The Android `versionCode` comes from the version
  (`major*10000 + minor*100 + patch`, so 1.2.3 → 10203). To sign with your own key instead of the
  debug key, set `FSHARE_KEYSTORE`, `FSHARE_KEYSTORE_PASSWORD`, `FSHARE_KEY_ALIAS` and
  `FSHARE_KEY_PASSWORD` first.
- **CLI** (`cli/package.json`): publishing pushes `cli-vX.Y.Z` and CI makes the GitHub release. It
  isn't on npm: `install.sh` and `fshare update` install whatever is on `main`.

## License

[MIT](LICENSE)
