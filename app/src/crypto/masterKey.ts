import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

// Custody of the local encrypted-store master key (see
// packages/signal-native/rust/src/store.rs for what it protects). Generated
// once via expo-crypto's CSPRNG, stored via expo-secure-store — which is
// Keychain-backed on iOS and Keystore-backed on Android — so no native
// Keychain/Keystore code had to be written by hand for this.
const LEGACY_STORAGE_KEY = 'signal-native-master-key';
const STORAGE_KEY = 'signal-native-master-key.v2';
const KEY_LENGTH_BYTES = 32;

/**
 * Readable after the phone has been unlocked once since it was switched on,
 * including while it is locked again; never copied to another device.
 *
 * The key used to be stored with expo-secure-store's default, readable only
 * while the phone is unlocked. That held until voice calls: a call arriving on
 * a locked phone wakes the app in the background, and the app could not read
 * this key, so it could not decrypt the call's offer -- the phone rang, the
 * call was answered, and there was no sound ("User interaction is not
 * allowed", 2026-11-22). This is the protection class Signal and WhatsApp use
 * for the same reason. What it gives up: on a phone that has been unlocked
 * since boot, an attacker who can run code inside this app while it is locked
 * could read the key. What it keeps: a phone just switched on and not yet
 * unlocked still cannot, and the key never leaves this device (no iCloud
 * Keychain, not in backups restored elsewhere).
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

function bytesToBase64(bytes: Uint8Array): string {
  const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let result = '';
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    result += CHARS[(chunk >> 18) & 63] + CHARS[(chunk >> 12) & 63] + CHARS[(chunk >> 6) & 63] + CHARS[chunk & 63];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const chunk = bytes[i] << 16;
    result += CHARS[(chunk >> 18) & 63] + CHARS[(chunk >> 12) & 63] + '==';
  } else if (remaining === 2) {
    const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8);
    result += CHARS[(chunk >> 18) & 63] + CHARS[(chunk >> 12) & 63] + CHARS[(chunk >> 6) & 63] + '=';
  }
  return result;
}

let cachedMasterKeyBase64: string | null = null;

/**
 * Returns the device's persistent-store master key as base64, generating
 * and storing a fresh one via expo-secure-store on first call. Memoized in
 * memory for the process lifetime — still re-reads from SecureStore once,
 * not on every call.
 */
export async function getOrCreateMasterKeyBase64(): Promise<string> {
  if (cachedMasterKeyBase64) {
    return cachedMasterKeyBase64;
  }

  const existing = await SecureStore.getItemAsync(STORAGE_KEY, OPTIONS);
  if (existing) {
    cachedMasterKeyBase64 = existing;
    return existing;
  }

  // Moving a key stored before the protection class changed. expo-secure-store
  // only updates the value of an existing item, never its protection class, so
  // the key is written again under a new name. The old copy is deleted only
  // once the new one has been read back and matches: if anything fails
  // half-way, both copies exist and the next launch tries again. Losing this
  // key would mean losing the identity and every conversation.
  //
  // Throws while the phone is locked if only the old copy exists, exactly as
  // before; it is migrated the next time the app runs unlocked.
  const legacy = await SecureStore.getItemAsync(LEGACY_STORAGE_KEY);
  if (legacy) {
    await SecureStore.setItemAsync(STORAGE_KEY, legacy, OPTIONS);
    const readBack = await SecureStore.getItemAsync(STORAGE_KEY, OPTIONS);
    if (readBack === legacy) {
      await SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY);
    }
    cachedMasterKeyBase64 = legacy;
    return legacy;
  }

  const randomBytes = await Crypto.getRandomBytesAsync(KEY_LENGTH_BYTES);
  const base64Key = bytesToBase64(randomBytes);
  await SecureStore.setItemAsync(STORAGE_KEY, base64Key, OPTIONS);
  cachedMasterKeyBase64 = base64Key;
  return base64Key;
}

/**
 * Deletes the master key from expo-secure-store. Used by account deletion
 * (identity/deleteAccount.ts) — the on-disk Signal Protocol store it
 * protects is separately wiped via crypto/index.ts::wipeLocalSignalStore.
 * Without both, a new master key would still be generated on next launch
 * but the OLD encrypted store files would remain undecryptable-but-present
 * on disk — harmless, but pointless to leave behind.
 */
export async function clearMasterKeyBase64(): Promise<void> {
  cachedMasterKeyBase64 = null;
  await SecureStore.deleteItemAsync(STORAGE_KEY, OPTIONS);
  await SecureStore.deleteItemAsync(LEGACY_STORAGE_KEY);
}
