# Signal-style E2EE messenger

See [`docs/threat-model.md`](docs/threat-model.md) for what this app protects
against and what it explicitly does not.

## Layout

- `app/` — Expo (React Native + TypeScript) mobile app. Requires a custom dev
  client (`eas.json`) — **Expo Go will not work** with native modules
  (crypto, Tor) wired in.
- `app/modules/signal-native-expo/` — the real bridge between the app and the
  Rust crypto crate: a local **Expo Module** wrapping uniffi's standard
  Kotlin/Swift bindings. Android is built and verified (`gradlew
  assembleDebug` succeeds, real `libsignal-protocol` linked in). iOS bindings
  are generated and the Swift module is written, but the Rust-for-iOS build
  itself has never run (no Mac/Xcode on this dev machine) — it's wired to
  run automatically on EAS Build's macOS workers on the first `eas build
  --platform ios` (see `packages/signal-native/README.md`).
- `packages/signal-native/` — the Rust crate itself, wrapping
  `signalapp/libsignal`'s `libsignal-protocol`. No custom cryptography here —
  everything security-relevant is delegated to that audited crate. Real
  X3DH/PQXDH + Double Ratchet, proven via `cargo test` (two simulated devices
  exchanging encrypted messages) — see its README.
- `packages/signal-native-rn/` — **abandoned.** An earlier attempt to bridge
  the Rust crate as a React Native TurboModule via
  `uniffi-bindgen-react-native`. Kept only as a record of why it didn't work
  with Expo's autolinking — see its README before reviving this approach.
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

## Getting started (app, iOS — needs EAS Build, untested end to end)

This dev machine has no Mac, so this path has been prepared but never
actually run. Two tiers, cheapest first:

### Tier 1 — free, no Apple account, proves the Rust/Xcode build itself works

`eas.json`'s `development-simulator` profile builds for the iOS **Simulator**
(`ios.simulator: true`), which needs no Apple Developer Program membership
at all (verified against Expo's current docs before adding this — simulator
builds are explicitly Apple-account-free). Caveat: the *resulting build*
only runs inside the Simulator app, which is macOS-only — without a Mac you
can't actually launch what gets built. The value here is narrower than a
real device test: it only proves `eas-build-post-install` (which runs
`packages/signal-native/rust/build-ios.sh`, building the Rust crate for iOS
and assembling an `.xcframework`) actually succeeds — genuinely the first
real execution of that script, so expect to debug something on the first
run. See the caveats comment at the top of `build-ios.sh` for the likely
failure points (exact toolchain install commands on the EAS image,
xcframework output path).

1. Create a free account at [expo.dev](https://expo.dev) if you don't have
   one, then `npm install -g eas-cli` and `eas login`.
2. From `app/`: `eas build --profile development-simulator --platform ios`.
   Runs entirely on Expo's macOS cloud workers — nothing more to install
   locally, no Apple account prompt.
3. Watch the build log for the `eas-build-post-install` step. Success here
   is the actual milestone — it's fine to stop at "the build completed"
   even without a Mac to install it on.

### Tier 2 — real device, needs a paid Apple account

1. Apple Developer Program membership (99 USD/year) — required by Apple to
   sign a build for a real iPhone, not something this project can avoid.
2. From `app/`: `eas build --profile development --platform ios` (the
   plain `development` profile, not `-simulator` — that one targets a real
   device and will prompt for Apple credentials during the build).
3. Once it succeeds, EAS gives you a link/QR code to install the dev client
   on your iPhone via TestFlight-style internal distribution.

Report back what breaks — this is the one part of the whole stack that has
had zero real-world execution yet.

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
