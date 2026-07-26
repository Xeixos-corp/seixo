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
actually run. Steps for whoever has an Expo/Apple Developer account:

1. Create a free account at [expo.dev](https://expo.dev) if you don't have
   one, then `npm install -g eas-cli` and `eas login`.
2. You'll need an Apple Developer Program membership (99 USD/year) to install
   on a real iPhone — required by Apple, not by us.
3. From `app/`: `eas build --profile development --platform ios`. This runs
   entirely on Expo's macOS cloud workers — nothing more to install locally.
4. Watch for failures in the `eas-build-post-install` hook step (runs
   `packages/signal-native/rust/build-ios.sh`, which builds the Rust crate
   for iOS and assembles an `.xcframework`) — this is genuinely the first
   execution of that script. See the caveats comment at the top of
   `build-ios.sh` for the most likely failure points (exact toolchain
   install commands on the EAS image, xcframework output path).
5. Once the build succeeds, EAS gives you a link/QR code to install the dev
   client on your iPhone via TestFlight-style internal distribution.

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
