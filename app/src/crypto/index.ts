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
  RotatedPrekeys,
  BackupCredentials,
} from '../../modules/signal-native-expo/src/SignalNativeExpo.types';

/**
 * What a backup blob holds once opened. The identity fields are added
 * natively; everything else is what the app chose to carry -- see
 * backup/recoveryBackup.ts for why that list is as short as it is.
 */
export type RecoveryBackupContents = {
  version: number;
  userId: string;
  createdAt: string;
  identityKeyPairBase64: string;
  registrationId: number;
};
import { getOrCreateMasterKeyBase64 } from './masterKey';

export type { EncryptedEnvelope, OneTimePrekeyPublic, PreKeyBundleData, BackupCredentials };

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

/**
 * Generates a new signed prekey and Kyber prekey under new ids, keeping the
 * previous ones. See the Rust doc comment: rotation is additive on purpose,
 * because a peer may have fetched the old bundle moments ago and be about to
 * send with it.
 */
export function rotateSignedPrekeys(signedPrekeyId: number, kyberPrekeyId: number): RotatedPrekeys {
  requireInitialized();
  return SignalNativeExpoModule.rotateSignedPrekeys(signedPrekeyId, kyberPrekeyId);
}

/** Deletes stored signed/Kyber prekeys other than the ones listed. */
export function prunePrekeys(keepSignedIds: number[], keepKyberIds: number[]): void {
  requireInitialized();
  SignalNativeExpoModule.prunePrekeys(keepSignedIds, keepKyberIds);
}

/**
 * The 60-digit code both sides compare to confirm nobody is impersonating
 * either of them. Identical on both phones, and different for every pair.
 */
export function safetyNumber(remoteUserId: string, remoteIdentityKeyBase64: string): string {
  requireInitialized();
  return SignalNativeExpoModule.safetyNumber(remoteUserId, remoteIdentityKeyBase64);
}

/**
 * Forgets a peer's identity so their next message is accepted afresh. The way
 * back from "their key changed", which used to block a conversation forever.
 */
export function forgetPeerIdentity(remoteUserId: string, remoteDeviceId: number): void {
  requireInitialized();
  SignalNativeExpoModule.forgetPeerIdentity(remoteUserId, remoteDeviceId);
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
 * Seals this device's identity, plus whatever `contents` the caller wants
 * carried, under a key derived from `phrase`.
 *
 * The identity's private half is read and sealed inside the native module and
 * never reaches JS -- see SignalNativeExpoModule.ts. Whoever holds it can be
 * this user to every contact, so the fewer places it exists, the better.
 */
export function createRecoveryBackup(phrase: string, contents: Record<string, unknown>): string {
  requireInitialized();
  return SignalNativeExpoModule.createRecoveryBackup(phrase, JSON.stringify(contents));
}

/** Opens a backup blob. Throws on a wrong phrase or a damaged file alike. */
export function readRecoveryBackup(phrase: string, blob: string): RecoveryBackupContents {
  return JSON.parse(SignalNativeExpoModule.readRecoveryBackup(phrase, blob));
}

/**
 * Plants a restored identity so the next `initSignalDevice` adopts it instead
 * of generating a fresh one.
 *
 * Must run on a device with no identity: the native side refuses otherwise,
 * so a mistaken restore cannot replace a working identity and leave the
 * session files beside it pointing at one that no longer exists.
 */
export async function restoreIdentityFromBackup(
  identityKeyPairBase64: string,
  registrationId: number,
): Promise<void> {
  const masterKeyBase64 = await getOrCreateMasterKeyBase64();
  SignalNativeExpoModule.restoreIdentityFromBackup(
    identityKeyPairBase64,
    registrationId,
    masterKeyBase64,
  );
  // The native side dropped its device handle; this side must agree, or the
  // next initSignalDevice() would think it had already run.
  deviceInitialized = false;
}

export function generateRecoveryPhrase(): string {
  return SignalNativeExpoModule.generateRecoveryPhrase();
}

/** Wordlist + checksum, so a typo is caught while the paper is still in hand. */
export function isValidRecoveryPhrase(phrase: string): boolean {
  return SignalNativeExpoModule.isValidRecoveryPhrase(phrase);
}

/** The account credentials a phrase implies -- derived, never stored. */
export function deriveBackupCredentials(phrase: string): BackupCredentials {
  return SignalNativeExpoModule.deriveBackupCredentials(phrase);
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
