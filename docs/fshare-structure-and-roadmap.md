# fshare — Project Structure & Versioned Roadmap

Local-first file sharing between Mac, Windows, Android, and iOS. Same WiFi, no internet, no accounts. **Rust core**, React Native (Expo) mobile, Tauri desktop.

**Guiding principle:** every version is a *standalone usable tool*. v0.1 is a CLI you actually use. Each later version only *adds* to the working thing before it. You should never be in a state of "half-built and unusable." v1.0.0 is the first complete release — not the end of learning, just the first finish line.

---

## 1. The architecture in one picture

```
                  ┌─────────────────────────────────────────┐
                  │        crates/core  (Rust library)       │
                  │  protocol · transfer · resume · sha256    │
                  │  discovery (mDNS) · crypto · ffi façade   │
                  └───────┬─────────────┬──────────────┬──────┘
         direct Rust dep  │             │ direct dep   │  uniffi-generated
                          │             │              │  Turbo Module (TS)
                          ▼             ▼              ▼
                 ┌──────────────┐ ┌───────────┐ ┌──────────────────┐
                 │ crates/cli   │ │ desktop/  │ │ mobile/          │
                 │ Rust binary  │ │ Tauri v2  │ │ Expo RN app      │
                 │ Mac/Linux/   │ │ Mac + Win │ │ Android + iOS    │
                 │ Termux       │ │ (+Linux)  │ │                  │
                 └──────────────┘ └───────────┘ └──────────────────┘
```

One Rust core, consumed three ways. The CLI and Tauri link it directly (Rust calling Rust). Mobile consumes it through a uniffi-generated TypeScript binding. **Write the hard logic once.**

---

## 2. What lives where

### `crates/core` — the Rust engine (all the real logic)
Everything platform-independent goes here, so every front-end inherits it for free:

- **protocol** — length-prefixed framing; message types (HELLO, OFFER, ACCEPT, FILE_START, chunk, FILE_END, DONE)
- **transfer** — chunked streaming, backpressure, byte accounting
- **resume** — per-file offset negotiation
- **integrity** — sha256 per file
- **discovery** — mDNS advertise + browse (no manual IPs)
- **crypto** — pairing secret + encrypted transport
- **ffi** — the *small* uniffi-annotated façade: a handful of functions + an event listener interface (progress, incoming, done, error). This is what mobile calls; keep it tiny and stable.

What it deliberately does **not** do: any UI, any OS file-picker. It's handed file paths (desktop) or file descriptors (mobile) and does its job.

### `crates/cli` — the dogfood tool
Thin binary over the core: arg parsing, calls the engine, prints progress. Runs on Mac, Linux, and on Android via Termux. **This is the thing you use daily** — the anti-quit foundation.

### `desktop/` — Tauri v2 app (Mac + Windows, Linux free)
- `src-tauri/` — Rust backend that depends on `core` directly (no FFI), exposing Tauri commands.
- `src/` — web frontend (React/TS) where your existing JS skill goes: device list, drag-drop, progress, QR display, save location, history, system tray.

### `mobile/` — Expo RN app (Android + iOS)
- `modules/fshare/` — the uniffi-generated Turbo Module wrapping `core` compiled for mobile.
- `app/` — RN UI: device list, file picker (resolves the OS pick to a descriptor the core can read), QR scan to pair, progress, history.

### Repo skeleton
```
fshare/
├── Cargo.toml              # cargo workspace
├── crates/
│   ├── core/               # the engine (lib)
│   │   └── src/{lib,protocol,transfer,resume,hash,discovery,crypto,ffi}.rs
│   └── cli/                # CLI (bin)
├── desktop/                # Tauri app (src-tauri/ + src/)
├── mobile/                 # Expo RN app (modules/fshare + app/)
├── docs/{PROTOCOL,ARCHITECTURE}.md
├── LICENSE                 # MIT
└── README.md
```

### A note on literal feature flags
Use **Cargo features** on `core` to gate optional modules: `discovery`, `crypto`, etc. The CLI in early versions builds with them off; later surfaces switch them on. This keeps early builds tiny and is itself good Rust learning (`#[cfg(feature = "...")]`).

---

## 3. The version ladder

Read this as four phases. **Phase A is mostly Rust learning on a problem you already understand** (your Node prototype is the spec). Phases B–D are mostly *new-tooling* learning layered on a core you already trust.

### Phase A — CLI (the core matures, you start using it)

| Version | Adds | Standalone use | New learning |
|---|---|---|---|
| **v0.1.0** | Rust port of your Node scripts: `fshare send <file> <ip>` / `fshare recv`. Hardcoded port, dumps to one file. | Move a file Mac↔Mac, then Mac↔phone (Termux). | Rust basics, `std::net`, file I/O, `clap` |
| v0.1.1 | JSON header (name + size), saves under real name | Filenames preserved | structs, `serde` |
| v0.1.2 | Length-prefixed framing | Robust message boundaries | buffers, byte handling |
| v0.1.3 | Live progress in terminal | You can watch transfers | streams, traits |
| **v0.2.0** | mDNS discovery — pick a device by name, no IP typing | Real convenience; feels like a tool | async (`tokio`), mDNS crate |
| v0.2.1 | Multi-file (manifest + loop) | Send many files at once | iterators, collections |
| **v0.3.0** | Resume interrupted transfers (offset negotiation) | Survives WiFi blips | error handling, state |
| v0.3.1 | sha256 verify + atomic `.part` → rename | Integrity guarantee, no half-files | hashing, fs semantics |
| **v0.4.0** | Pairing secret + encrypted transport (manual code exchange) | **Secure, complete CLI** | crypto crate, TLS/Noise |

**→ SHIP HERE.** Tag **v0.4.0** as your first public release: README, a downloadable binary, a `cargo install` line. This is "shipped." Breaking the quit-pattern once, early, on a tool you genuinely use, is the whole point.

### Phase B — Desktop (Tauri)

| Version | Adds | Standalone use | New learning |
|---|---|---|---|
| **v0.5.0** | Tauri app wrapping the core: device list, send/receive with native dialogs | A real GUI app on **Mac + Windows** | Tauri v2, commands, web↔Rust IPC |
| v0.5.1 | Drag-and-drop to send, progress UI, system tray | Daily-driver desktop app | frontend events, tray APIs |
| v0.5.2 | Display pairing QR on screen | Ready for phones to scan | QR generation |

### Phase C — Mobile (the biggest new lift)

| Version | Adds | Standalone use | New learning |
|---|---|---|---|
| **v0.6.0** | uniffi → Turbo Module; minimal Expo app: receive a file | Phone receives from desktop | uniffi-bindgen-react-native, dev builds |
| v0.6.1 | Send from phone (document picker → core) | Both directions on phone | SAF / file-descriptor handoff |
| **v0.7.0** | QR pairing end-to-end (scan desktop's QR) | Tap-to-pair, no typing | camera, deep cross-device flow |

### Phase D — Polish to v1.0

| Version | Adds | Standalone use | New learning |
|---|---|---|---|
| **v0.8.0** | Transfer UX: save-location picker, history, queue management, both-end progress | Pleasant to use | state mgmt, persistence |
| **v0.9.0** | Hardening: cancel, disk-full, timeouts, client-isolation detection + hotspot fallback | Doesn't break in the real world | edge cases, resilience |
| v0.9.x | Bug-fix passes from real use | Stable | debugging |
| **v1.0.0** | All four platforms, secure, resumable, multi-file, polished. App icons, signed builds, docs. | **The finish line.** | release engineering |

---

## 4. Why this order resists quitting

The danger zone is the stretch before the *first usable thing* — and with Rust that stretch is longer. This ladder makes v0.1.0 usable on day one of real coding, because you're translating a proven design, not inventing one. By v0.4.0 you have a secure tool you depend on and have publicly shipped. Everything after that is enhancing something that already works and already pays you back — so the deep learning (Tauri, uniffi, mobile) happens on a foundation, not in a void.

Each **bold** version is a genuine stopping point where the project is complete and useful. If life happens and you stop at v0.4.0 or v0.5.2, you still have a real, shipped, used tool — not a corpse. That's the structural defense.

---

## 5. First action
Set up the Cargo workspace, create `crates/core` and `crates/cli`, and port your two Node scripts into Rust as v0.1.0: `send` and `recv`, hardcoded port, one file. Get it moving a file Mac→Mac, then Mac↔phone over Termux. That's v0.1.0 done — and you're now a Rust programmer with a working tool.
