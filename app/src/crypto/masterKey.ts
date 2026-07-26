import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

// Custody of the local encrypted-store master key (see
// packages/signal-native/rust/src/store.rs for what it protects). Generated
// once via expo-crypto's CSPRNG, stored via expo-secure-store — which is
// Keychain-backed on iOS and Keystore-backed on Android — so no native
// Keychain/Keystore code had to be written by hand for this.
const STORAGE_KEY = 'signal-native-master-key';
const KEY_LENGTH_BYTES = 32;

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

  const existing = await SecureStore.getItemAsync(STORAGE_KEY);
  if (existing) {
    cachedMasterKeyBase64 = existing;
    return existing;
  }

  const randomBytes = await Crypto.getRandomBytesAsync(KEY_LENGTH_BYTES);
  const base64Key = bytesToBase64(randomBytes);
  await SecureStore.setItemAsync(STORAGE_KEY, base64Key);
  cachedMasterKeyBase64 = base64Key;
  return base64Key;
}
