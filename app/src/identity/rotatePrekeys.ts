import { rotateSignedPrekeys, prunePrekeys } from '../crypto';
import { replaceSignedPrekey } from '../transport/identities';
import { loadPrekeyAllocation, savePrekeyAllocation, type PrekeyAllocation } from './prekeyState';

/**
 * How often a new signed/Kyber prekey pair is generated. Signal rotates every
 * couple of days; the point is to bound how far back a stolen private key
 * reaches, and two days is a small enough window to be worth the churn.
 */
const ROTATE_AFTER_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * How long a superseded private key is kept before deletion.
 *
 * This is the number that must not be too small. A peer can fetch a bundle
 * and only send days later; if the private half is gone by then, the message
 * is unreadable forever and nobody is told. Thirty days is deliberately far
 * more than any plausible delay -- Signal uses roughly the same -- because
 * being wrong in this direction destroys messages while being wrong in the
 * other merely keeps a key slightly longer than necessary.
 */
const KEEP_OLD_KEYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Rotates the signed and Kyber prekeys if they are old enough, and prunes
 * ones old enough to be safe to forget.
 *
 * Non-fatal throughout: rotation failing means the previous key stays in use,
 * which is exactly the situation before rotation existed. Blocking startup or
 * surfacing an error for it would be a worse outcome than the thing it
 * protects against.
 */
export async function rotatePrekeysIfDue(userId: string): Promise<void> {
  try {
    const allocation = await loadPrekeyAllocation(userId);
    if (!allocation) return;

    const history = allocation.signedPrekeys ?? [];
    const newest = history[history.length - 1];
    const now = Date.now();

    if (newest && now - Date.parse(newest.createdAt) < ROTATE_AFTER_MS) {
      await pruneIfDue(userId, allocation, history, now);
      return;
    }

    // Ids never reused: a peer holding an old public key must never find a
    // different private key behind the same id.
    const nextSignedId = allocation.nextSignedId ?? 2;
    const rotated = rotateSignedPrekeys(nextSignedId, nextSignedId);

    // Published before recording it locally. If publishing fails we simply
    // try again next launch with a new id; if we recorded first and then
    // failed, the local store would fill with keys the server never saw.
    await replaceSignedPrekey(userId, rotated);

    const updated: PrekeyAllocation = {
      ...allocation,
      nextSignedId: nextSignedId + 1,
      signedPrekeys: [
        ...history,
        { signedId: rotated.signedPrekeyId, kyberId: rotated.kyberPrekeyId, createdAt: new Date(now).toISOString() },
      ],
    };
    await savePrekeyAllocation(updated);
    await pruneIfDue(userId, updated, updated.signedPrekeys ?? [], now);
  } catch (error) {
    console.warn('[rotatePrekeys] rotation skipped', error);
  }
}

async function pruneIfDue(
  userId: string,
  allocation: PrekeyAllocation,
  history: { signedId: number; kyberId: number; createdAt: string }[],
  now: number,
): Promise<void> {
  if (history.length < 2) return;

  // The newest is always kept, whatever its age -- it is the one the server
  // is handing out right now.
  const newest = history[history.length - 1];
  const keep = history.filter(
    (entry) => entry === newest || now - Date.parse(entry.createdAt) < KEEP_OLD_KEYS_MS,
  );
  if (keep.length === history.length) return;

  prunePrekeys(
    keep.map((entry) => entry.signedId),
    keep.map((entry) => entry.kyberId),
  );
  await savePrekeyAllocation({ ...allocation, signedPrekeys: keep });
}
