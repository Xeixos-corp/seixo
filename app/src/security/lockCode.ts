import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

/** Digits in a code. Six, like the iPhone's own: familiar, and quick to type under pressure. */
export const CODE_LENGTH = 6;

const STORAGE_KEY = 'seixo.lock-codes.v1';

type StoredCodes = {
  salt: string;
  /** Hash of the code that opens the app. */
  unlock: string;
  /** Hash of the panic code, when one is set. */
  panic: string | null;
};

/**
 * In the Keychain, readable only while this phone is unlocked and never
 * copied to another device or into a backup. The codes are stored as salted
 * hashes, never as they were typed.
 *
 * A hash of six digits does not stop someone who can already read this
 * phone's Keychain -- a million guesses is nothing. It is not meant to: that
 * person has the whole phone. It keeps the codes out of any casual dump, and
 * out of anything that syncs.
 */
const OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function read(): Promise<StoredCodes | null> {
  const raw = await SecureStore.getItemAsync(STORAGE_KEY, OPTIONS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredCodes;
  } catch {
    return null;
  }
}

async function write(codes: StoredCodes): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(codes), OPTIONS);
}

function hash(salt: string, code: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${salt}:${code}`);
}

function randomSalt(): string {
  return Array.from(Crypto.getRandomBytes(16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function isWellFormed(code: string): boolean {
  return new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code);
}

/** Sets the code that opens the app, keeping a panic code if there is one. */
export async function setUnlockCode(code: string): Promise<void> {
  if (!isWellFormed(code)) throw new Error('A code is six digits');
  const existing = await read();
  const salt = existing?.salt ?? randomSalt();
  const unlock = await hash(salt, code);
  // A new unlock code that matches the panic code would make every unlock a
  // wipe. Refused here as well as on screen, because this is the one mistake
  // that costs everything.
  if (existing?.panic && existing.panic === unlock) throw new Error('Same as the panic code');
  await write({ salt, unlock, panic: existing?.panic ?? null });
}

/** Sets the panic code. Refuses the unlock code itself. */
export async function setPanicCode(code: string): Promise<void> {
  if (!isWellFormed(code)) throw new Error('A code is six digits');
  const existing = await read();
  if (!existing) throw new Error('No unlock code set');
  const panic = await hash(existing.salt, code);
  if (panic === existing.unlock) throw new Error('Same as the unlock code');
  await write({ ...existing, panic });
}

export async function clearPanicCode(): Promise<void> {
  const existing = await read();
  if (existing) await write({ ...existing, panic: null });
}

export async function hasPanicCode(): Promise<boolean> {
  return Boolean((await read())?.panic);
}

export async function hasUnlockCode(): Promise<boolean> {
  return Boolean((await read())?.unlock);
}

/** Whether `code` is the unlock code -- used to refuse it as a panic code before hashing twice. */
export async function isUnlockCode(code: string): Promise<boolean> {
  const existing = await read();
  return Boolean(existing && (await hash(existing.salt, code)) === existing.unlock);
}

export type CodeCheck = 'unlock' | 'panic' | 'wrong' | 'missing';

/**
 * Which code this is. Both are always compared, so the answer takes the same
 * time whichever one matched -- nothing on screen, or in how long it took,
 * says that a panic code exists.
 */
export async function checkCode(code: string): Promise<CodeCheck> {
  const stored = await read();
  if (!stored?.unlock) return 'missing';
  const candidate = await hash(stored.salt, code);
  const isUnlock = candidate === stored.unlock;
  const isPanic = stored.panic !== null && candidate === stored.panic;
  if (isPanic) return 'panic';
  if (isUnlock) return 'unlock';
  return 'wrong';
}

export async function clearCodes(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY, OPTIONS);
}
