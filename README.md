# Seixo — a Signal-style E2EE messenger

See [`docs/threat-model.md`](docs/threat-model.md) for what this app protects
against and what it explicitly does not.

## Layout

- `app/` — Expo (React Native + TypeScript) mobile app. Requires a custom dev
  client (`eas.json`) — **Expo Go will not work** with native modules
  (crypto, Tor) wired in.
- `app/modules/signal-native-expo/` — the real bridge between the app and the
  Rust crypto crate: a local **Expo Module** wrapping uniffi's standard
  Kotlin/Swift bindings. Android is built and verified (`gradlew
  assembleDebug` succeeds, real `libsignal-protocol` linked in — genuinely
  confirmed this time, not just "build succeeded"; see the 2026-08-06
  correction in `packages/signal-native/README.md` about a real autolinking
  bug that made every earlier version of this claim a false positive). iOS:
  three separate linking bugs were found and fixed via real device runs on
  2026-08-06 (autolinking discovery, EAS hook ordering, podspec deployment
  target) — see `docs/threat-model.md`'s "Native crypto module autolinking"
  section and follow-ups. The "Install pods" log now confirms
  `SignalNativeExpo` is included (89/89 pods); installing this build on the
  real device to confirm the runtime error is gone is the next step.
- `packages/signal-native/` — the Rust crate itself, wrapping
  `signalapp/libsignal`'s `libsignal-protocol`. No custom cryptography here —
  everything security-relevant is delegated to that audited crate. Real
  X3DH/PQXDH + Double Ratchet, proven via `cargo test` (two simulated devices
  exchanging encrypted messages) — see its README.
- `packages/signal-native-rn/` — **abandoned.** An earlier attempt to bridge
  the Rust crate as a React Native TurboModule via
  `uniffi-bindgen-react-native`. Kept only as a record of why it didn't work
  with Expo's autolinking — see its README before reviving this approach.
- `app/src/i18n/` — Portuguese/English/Spanish translations (`i18next` +
  `react-i18next` + `expo-localization`), auto-selected by device language
  with a Portuguese fallback. No manual language switcher. Every screen
  string lives in `locales/{pt,en,es}.json` — add a key there, not inline
  text, when adding UI copy.
- `supabase/` — database schema/migrations (metadata-minimized, TTL-purged,
  RLS-enforced) and the self-hosted Docker stack for later. Development
  currently targets Supabase Cloud — see `supabase/README.md`.
- `docs/` — threat model and other living design docs.

## Getting started (app, Android — buildable locally today)

```
cd app
npm install
cp .env.example .env   # fill in Supabase project URL + anon key
npx expo prebuild --platform android
cd android && ./gradlew assembleDebug
```

## Getting started (app, iOS — needs EAS Build; Tier 1 confirmed working 2026-07-26)

This dev machine has no Mac, so this path had to be verified via EAS Build's
cloud workers instead. Two tiers, cheapest first:

### Tier 1 — free, no Apple account, proves the Rust/Xcode build itself works

`eas.json`'s `development-simulator` profile builds for the iOS **Simulator**
(`ios.simulator: true`), which needs no Apple Developer Program membership
at all (verified against Expo's current docs before adding this — simulator
builds are explicitly Apple-account-free). The build itself succeeds
(`packages/signal-native/rust/build-ios.sh` genuinely cross-compiles the
Rust crate and assembles an `.xcframework` on EAS's macOS workers). This
profile hasn't been re-run since the three linking bugs below were fixed
(all verification since has happened via Tier 2's real-device profile
instead) — no reason to expect it behaves differently, since both share the
same `expo-module.config.json`/hook/podspec, but it's untested.

1. Create a free account at [expo.dev](https://expo.dev) if you don't have
   one, then `npm install -g eas-cli` and `eas login`.
2. From `app/`: `eas build --profile development-simulator --platform ios`.
   Runs entirely on Expo's macOS cloud workers — nothing more to install
   locally, no Apple account prompt.
3. Watch the build log for the `eas-build-pre-install` step (runs before
   `npm install`, building the `.xcframework` so it exists in time for
   `pod install` to find it — see `docs/threat-model.md` for why this used
   to be `eas-build-post-install`, which ran too late). Success here is the
   actual milestone — it's fine to stop at "the build completed" even
   without a Mac to install it on.

### Tier 2 — real device, needs a paid Apple account

1. Apple Developer Program membership (99 USD/year) — required by Apple to
   sign a build for a real iPhone, not something this project can avoid.
2. From `app/`: `eas build --profile development --platform ios` (the
   plain `development` profile, not `-simulator` — that one targets a real
   device and will prompt for Apple credentials during the build).
3. Once it succeeds, EAS gives you a link/QR code to install the dev client
   on your iPhone via TestFlight-style internal distribution.

Tier 2 has been run multiple times against a real Apple Developer account
and a real iPhone (2026-08-06). The first real install surfaced `Cannot
find native module 'SignalNativeExpo'` at runtime, which turned out to be
three separate linking bugs, all now fixed, verified, and documented in
`docs/threat-model.md`'s "Native crypto module autolinking" section — the
module now loads cleanly on a real device. Still open: exercising the
actual Signal Protocol calls (register identity, establish a session,
send/receive an encrypted message) through it on iOS, which hasn't been
attempted yet;
same as Tier 1's first run.

## Regenerating the Kotlin/Swift bindings after a Rust API change

```
cd packages/signal-native/rust
cargo build --bin uniffi-bindgen --features cli

# Kotlin (Android)
cargo run --bin uniffi-bindgen --features cli -- generate \
  --library target/aarch64-linux-android/debug/libsignal_native.so \
  --language kotlin --out-dir ../kotlin-out
cp ../kotlin-out/uniffi/signal_native/signal_native.kt \
  ../../../app/modules/signal-native-expo/android/src/main/java/uniffi/signal_native/

# Swift (iOS) — the Windows-built .dll works fine here too; uniffi-bindgen
# only reads its embedded metadata, it doesn't need an iOS-specific artifact.
cargo run --bin uniffi-bindgen --features cli -- generate \
  --library target/debug/signal_native.dll \
  --language swift --out-dir ../swift-out
cp ../swift-out/signal_native.swift ../swift-out/signal_nativeFFI.h \
  ../../../app/modules/signal-native-expo/ios/generated/
```
Then update `SignalNativeExpoModule.kt` / `SignalNativeExpoModule.swift` and
`app/modules/signal-native-expo/src/*.ts` if the API surface changed.
