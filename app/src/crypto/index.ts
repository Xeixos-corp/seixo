// Wraps the real libsignal-protocol integration, bridged as a local Expo
// Module (app/modules/signal-native-expo) around the Rust crate in
// packages/signal-native. Milestone 0's stub free-function interface has
// been replaced a few times now:
//   1. Milestone 1 first slice: a stateful SignalDevice object (still true).
//   2. The bridging mechanism changed from a React Native TurboModule
//      (packages/signal-native-rn, abandoned — incompatible with Expo's own
//      autolinking, see that package's README) to a proper Expo Module,
//      which is what Expo's tooling actually supports well.
//   3. Milestone 2.5: the Rust side persists identity/session state to an
//      encrypted on-disk store (packages/signal-native/rust/src/store.rs)
//      instead of losing it every restart — this is why initSignalDevice is
//      now async (it has to fetch/create the master key from
//      expo-secure-store first; see ./masterKey.ts).

import SignalNativeExpoModule from '../../modules/signal-native-expo/src/SignalNativeExpoModule';
import type {
  EncryptedEnvelope,
  OneTimePrekeyPublic,
  PreKeyBundleData,
} from '../../modules/signal-native-expo/src/SignalNativeExpo.types';
import { getOrCreateMasterKeyBase64 } from './masterKey';

export type { EncryptedEnvelope, OneTimePrekeyPublic, PreKeyBundleData };

let deviceInitialized = false;

/**
 * Creates (once per app session) the local device's Signal Protocol
 * identity — reusing whatever the persistent encrypted store already has
 * for this master key, or generating a fresh identity on first run. Safe to
 * call multiple times: later calls are a no-op, not a second identity.
 */
export async function initSignalDevice(userId: string, deviceId: number): Promise<void> {
  if (!deviceInitialized) {
    const masterKeyBase64 = await getOrCreateMasterKeyBase64();
    SignalNativeExpoModule.createDevice(userId, deviceId, masterKeyBase64);
    deviceInitialized = true;
  }
}

function requireInitialized() {
  if (!deviceInitialized) {
    throw new Error('SignalDevice not initialized — call initSignalDevice() first (e.g. on login/registration).');
  }
}

export function identityPublicKeyBase64(): string {
  requireInitialized();
  return SignalNativeExpoModule.identityPublicKeyBase64();
}

export function generatePrekeyBundle(
  oneTimePrekeyId: number,
  signedPrekeyId: number,
  kyberPrekeyId: number,
): PreKeyBundleData {
  requireInitialized();
  return SignalNativeExpoModule.generatePrekeyBundle(oneTimePrekeyId, signedPrekeyId, kyberPrekeyId);
}

/**
 * Generates a pool of additional one-time prekeys beyond the single one
 * `generatePrekeyBundle` produces — see that Rust function's doc comment
 * for why one isn't enough (only the first peer to claim a bundle since the
 * last publish gets a one-time prekey at all).
 */
export function generateExtraOneTimePrekeys(ids: number[]): OneTimePrekeyPublic[] {
  requireInitialized();
  return SignalNativeExpoModule.generateExtraOneTimePrekeys(ids);
}

export function establishSession(
  remoteUserId: string,
  remoteDeviceId: number,
  bundle: PreKeyBundleData,
): void {
  requireInitialized();
  SignalNativeExpoModule.establishSession(remoteUserId, remoteDeviceId, bundle);
}

export function encryptMessage(
  remoteUserId: string,
  remoteDeviceId: number,
  plaintext: string,
): EncryptedEnvelope {
  requireInitialized();
  return SignalNativeExpoModule.encrypt(remoteUserId, remoteDeviceId, plaintext);
}

export function decryptMessage(
  remoteUserId: string,
  remoteDeviceId: number,
  envelope: EncryptedEnvelope,
): string {
  requireInitialized();
  return SignalNativeExpoModule.decrypt(remoteUserId, remoteDeviceId, envelope);
}

/** Testing/logout only — does not wipe native-side key material by itself. */
export function resetSignalDevice(): void {
  deviceInitialized = false;
}

/**
 * Deletes the on-disk encrypted Signal Protocol store (store.rs's *.enc
 * files) so a later initSignalDevice() call generates a genuinely fresh
 * identity instead of silently reloading the old one. Used by account
 * deletion (identity/deleteAccount.ts) — NOT part of normal app logout,
 * since normal logout should preserve the identity for next launch.
 */
export function wipeLocalSignalStore(): void {
  SignalNativeExpoModule.wipeLocalStore();
  deviceInitialized = false;
}

/**
 * True when `establishSession`/`encryptMessage`/`decryptMessage` failed
 * because the peer's identity key no longer matches what we saw in an
 * earlier session — the equivalent of Signal's "safety number changed"
 * warning (trust-on-first-use in
 * packages/signal-native/rust/src/store.rs::FileIdentityKeyStore).
 * `ERR_UNTRUSTED_IDENTITY` is set on the thrown error by
 * SignalNativeExpoModule.kt/.swift; see those for why it's not just a
 * generic decrypt failure. Callers should show a specific message, not
 * silently retry or swallow it.
 */
export function isUntrustedIdentityError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_UNTRUSTED_IDENTITY';
}
