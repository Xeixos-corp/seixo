# signal-native

Native crypto module: wraps [`signalapp/libsignal`](https://github.com/signalapp/libsignal)
(Rust, `libsignal-protocol` crate). Bridged to the Expo app as a local **Expo
Module** (`app/modules/signal-native-expo`) using uniffi's standard Kotlin
bindgen — the same binding style Mozilla/Signal use in production Android
apps. An earlier attempt to bridge via `uniffi-bindgen-react-native` (RN
TurboModule generator) is abandoned — see `packages/signal-native-rn/README.md`
for why (Expo's autolinking isn't what that tool was built/tested against).

## Status: Android done end to end (verified for real, see caveat below); iOS build verified via EAS, autolinking bug fixed, runtime pending a fresh build

`rust/src/lib.rs` wraps the **real** `libsignal-protocol` crate (fetched
directly from `signalapp/libsignal` as a git dependency — no custom
cryptography is implemented in this repo). `cargo test` proves a full
two-party flow works: PQXDH session establishment from a published prekey
bundle, then Double Ratchet message exchange in both directions, verifying
the ratchet advances (first message is a PreKey-type message, subsequent ones
are ordinary Whisper-type messages).

Beyond the Rust-level test, the full chain is now built and verified for
Android: `cargo-ndk` cross-compiles this crate for all 4 Android ABIs,
`cargo run --bin uniffi-bindgen -- generate --language kotlin` produces real
Kotlin bindings (checked into
`app/modules/signal-native-expo/android/src/main/java/uniffi/signal_native/`),
and `app/android && ./gradlew assembleDebug` **succeeds**, producing a real
debug APK with the crypto module linked in.

**Important correction (2026-08-06)**: every "`gradlew assembleDebug`
succeeds" claim before this date was a false positive. The module was
missing `app/modules/signal-native-expo/package.json` and never listed as a
dependency in `app/package.json`, so Expo's autolinking silently never
discovered it on *either* platform — Gradle happily built the rest of the
app and reported success without ever attempting to compile our module at
all. This stayed hidden because Android was never runtime-tested (no
emulator, no physical device) — the bug only surfaced once the app actually
ran on a real iPhone for the first time and threw `Cannot find native
module 'SignalNativeExpo'`. Separately, `expo-module.config.json` declared
`"apple"` as the iOS platform key/value where this Expo SDK's autolinking
(`expo-modules-autolinking`) expects `"ios"` — both bugs are now fixed, and
this time verified properly: the `:signal-native-expo:*` Gradle subproject
tasks were confirmed present in the `assembleDebug` output (not just
"BUILD SUCCESSFUL" on its own, which doesn't prove inclusion), and
`npx expo-modules-autolinking resolve --platform apple` — the actual
command the generated Podfile uses — now correctly resolves the module,
its podspec, and its Swift module name. A fresh EAS iOS build is still
needed to confirm this same fix carries through to a real device (the
device run that surfaced the bug used a build compiled before the fix).

Note this version of libsignal makes the Kyber/PQXDH prekey **mandatory**,
not optional — so this integration is post-quantum-resistant key agreement by
default, not just classic X3DH.

Exposed via `#[uniffi::export]` on the `SignalDevice` object:
- `SignalDevice::new(user_id, device_id, master_key, storage_dir)` — opens
  the encrypted on-disk store at `storage_dir` if one already exists there
  (loading the existing identity/sessions/prekeys), otherwise generates a
  fresh identity and persists it immediately. See `rust/src/store.rs`.
- `identity_public_key_base64()`
- `generate_prekey_bundle(one_time_id, signed_id, kyber_id)` — the data to
  publish to `supabase.signed_prekeys` / `supabase.one_time_prekeys`.
- `generate_extra_one_time_prekeys(ids)` — generates and stores additional
  one-time EC prekeys without touching the signed/Kyber prekey, so a pool of
  many can be published instead of just the bundle's single one-time key.
  Fixes a real bug: with only one published one-time prekey, only the first
  peer to claim it before the next registration got one at all (claiming
  deletes it server-side) — see `app/src/transport/identities.ts` and the
  threat model's "Persistent key/session storage" section.
- `establish_session(remote_user_id, remote_device_id, bundle)`
- `encrypt(remote_user_id, remote_device_id, plaintext)` /
  `decrypt(remote_user_id, remote_device_id, envelope)`

All three raise a distinguishable `SignalNativeError::UntrustedIdentity` (not
a generic `Protocol` error) when a peer's identity key doesn't match what
was seen in an earlier session — Signal's "safety number changed" case.
Proven by `establish_session_rejects_changed_peer_identity` in
`rust/src/lib.rs`. The Expo Module layer rethrows this as
`error.code === "ERR_UNTRUSTED_IDENTITY"` on the JS side (see
`app/src/crypto/index.ts::isUntrustedIdentityError` and the warning banners
in `ConversationScreen.tsx`/`ConversationListScreen.tsx`) instead of a
swallowed console.error.

`app/src/crypto/index.ts` wraps the Expo Module (`SignalNativeExpoModule`)
with this same shape, as free functions operating on one implicit
per-process device (`initSignalDevice`, `generatePrekeyBundle`,
`establishSession`, `encryptMessage`, `decryptMessage`).

## Persistent storage (Milestone 2.5 — done)

`rust/src/store.rs` implements all five libsignal-protocol storage traits
(`IdentityKeyStore`, `PreKeyStore`, `SignedPreKeyStore`, `KyberPreKeyStore`,
`SessionStore`) backed by AES-256-GCM-encrypted files under `storage_dir`
(one file per store; every mutation re-encrypts and atomically rewrites its
file). This is not a reimplementation of any Signal Protocol cryptography —
it's a thin at-rest encryption envelope (the `aes-gcm` crate, RustCrypto,
not hand-written cipher code) around bytes libsignal-protocol already knows
how to serialize.

Custody of the 32-byte encryption key is JS-side: `app/src/crypto/masterKey.ts`
generates it once via `expo-crypto` and stores it via `expo-secure-store`
(Keychain-backed on iOS, Keystore-backed on Android) — no hand-written
Keychain/Keystore integration code was needed. `storage_dir` is resolved
natively (one line each in `SignalNativeExpoModule.kt`/`.swift` — the app's
private files directory), never exposed to JS.

Verified with a dedicated `cargo test`
(`session_survives_simulated_restart`): establishes a real session between
two devices, **drops and reconstructs** each `SignalDevice` mid-conversation
from the same `storage_dir`/`master_key` (exactly what happens on a real app
restart), and proves the conversation keeps working on both sides afterward
— not just that files get written, that the round trip actually survives.

**What's still missing:**

1. ~~iOS build itself~~ **Done** — `eas build --profile development-simulator
   --platform ios` succeeded on the first real run (2026-07-26): the
   `eas-build-post-install` hook (`app/scripts/eas-build-post-install.js`)
   ran `rust/build-ios.sh` on EAS's macOS workers, cross-compiling this
   crate for `aarch64-apple-ios` + the simulator targets, assembling the
   `.xcframework`, and the full Xcode/CocoaPods build linked it
   successfully — no debugging needed, it worked first try. Still open:
   this was a **simulator** build (no Apple Developer account needed — see
   root `README.md`); a real-device build (`development` profile) still
   needs that paid account, and hasn't been attempted. Simulator builds
   also can't actually be launched without a Mac (Simulator.app is
   macOS-only), so runtime behavior on iOS remains unverified even though
   the build itself now proven to succeed.
2. **Not actually run on a device/emulator yet, on either platform** — `gradlew assembleDebug`
   proves it *compiles and links*, not that `SignalDevice` calls succeed at
   runtime through the JNA/JNI boundary. That's the next verification step
   once an emulator or physical Android device is available.
3. **No key rotation, no backup/multi-device sync, no recovery if the local
   store is lost or corrupted.** Losing the device (or the OS wiping
   Keychain/Keystore, e.g. after an uninstall) means losing the identity
   permanently — there is intentionally no server-side backup of any of
   this. That is the correct security tradeoff for this app (a server-held
   backup of identity/session keys would defeat much of the point), but
   it's worth being explicit that "persistent" means "survives app
   restarts," not "survives losing the device."

## Local build requirements (now verified working on this machine)

Building this crate needs, in addition to the Rust toolchain: the MSVC C++
Build Tools (`link.exe`) and Windows SDK (`kernel32.lib` etc.) on Windows,
`protoc` (Protocol Buffers compiler) on `PATH` (one of libsignal's
dependencies compiles `.proto` files at build time), and for Android: the
NDK + `cargo-ndk` + the four `*-linux-android*` Rust targets. All installed
on this dev machine already.

## Security note

Private key material must never cross the JS/native boundary in plaintext.
The `SignalDevice` design keeps the `IdentityKeyPair` and all session state
inside the Rust object, only ever returning public key material
(base64-encoded) or opaque ciphertext across the FFI boundary.
