import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'seixo.prekey-allocation.v1';

/**
 * Which one-time prekey ids this device has already handed out, and for whom.
 *
 * Exists because prekey ids must never be reused with a different key. A peer
 * claims a one-time prekey (public part) and may not send with it for some
 * time; if this device regenerates that id in the meantime, the private key
 * that would have opened the resulting message is gone and the message is
 * permanently undecryptable.
 *
 * That is exactly what used to happen: doRegister ran on every launch and
 * regenerated ids 1..20 unconditionally, so restarting the app between a peer
 * claiming a prekey and their first message being decrypted destroyed that
 * message. Because messages are only decrypted when their conversation is
 * opened, that window was routinely hours long.
 */
export type PrekeyAllocation = {
  /** Whose identity these ids were allocated for. A different user means start over. */
  userId: string;
  /** The next id that is safe to allocate; every id below it is spoken for. */
  nextId: number;
  /**
   * Signed and Kyber prekeys this device has generated, newest last.
   *
   * Kept because rotation is additive: the private halves of older keys stay
   * in the local store so that a message encrypted to one still opens. This
   * records which ids exist and when, so they can eventually be pruned --
   * and it is the only place that knows, since the store itself has no notion
   * of age.
   *
   * Absent on records written before rotation existed; treated as "one key,
   * generated at registration".
   */
  signedPrekeys?: { signedId: number; kyberId: number; createdAt: string }[];
  /** Next id to use for a rotated signed/Kyber pair. Separate id space from one-time prekeys. */
  nextSignedId?: number;
};

export async function loadPrekeyAllocation(userId: string): Promise<PrekeyAllocation | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PrekeyAllocation;
    // A different user id means this device re-registered (reinstall, or
    // account deletion): the old allocation says nothing about the new
    // identity's keys, so it must not be trusted.
    if (parsed.userId !== userId) return null;
    return parsed;
  } catch (error) {
    // A corrupt record must not brick registration. Falling back to null
    // means republishing a fresh bundle, which is safe -- just wasteful.
    console.error('[prekeyState] could not read allocation, starting fresh', error);
    return null;
  }
}

export async function savePrekeyAllocation(allocation: PrekeyAllocation): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(allocation));
}

export async function clearPrekeyAllocation(): Promise<void> {
  await AsyncStorage.removeItem(STORAGE_KEY);
}
