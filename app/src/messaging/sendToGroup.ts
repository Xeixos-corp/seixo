import { encryptMessage, establishSession } from '../crypto';
import { claimPeerPrekeyBundle } from '../transport/identities';
import { sendPackedMessage } from '../transport/messages';
import { packGroupMessage } from './groupEnvelope';
import type { EncryptedEnvelope } from '../crypto';

const REMOTE_DEVICE_ID = 1;

/** Thrown when a group has no members besides this device. */
export class EmptyGroupError extends Error {}

/**
 * Encrypts one copy of a message for every other member and sends them as a
 * single row.
 *
 * The cost is linear in group size, which is why groups are capped at ten:
 * a minute of audio is about 180 KB, and ten of those in one row would not be
 * reasonable. Text is negligible either way.
 *
 * A member with no session yet gets one established first, by claiming their
 * prekey bundle exactly as starting a conversation would. That is the normal
 * case for anyone added to the group after this device joined.
 *
 * Members who cannot be reached at all are skipped rather than failing the
 * send. Someone who deleted their account between being added and this
 * message going out should not stop everyone else from receiving it -- and
 * the alternative, refusing to send, would be indistinguishable to the user
 * from the app being broken.
 */
export async function sendGroupMessage(
  channelId: string,
  selfUserId: string,
  memberIds: string[],
  plaintext: string,
  ttlSeconds: number,
  options: { silent?: boolean; serverTtlSeconds?: number } = {},
): Promise<{ id: string; createdAt: string; expiresAt: string }> {
  const recipients = memberIds.filter((id) => id !== selfUserId);
  const perMember: Record<string, EncryptedEnvelope> = {};

  for (const memberId of recipients) {
    try {
      perMember[memberId] = encryptMessage(memberId, REMOTE_DEVICE_ID, plaintext);
    } catch {
      // No session with this member yet: establish one and try again. Any
      // failure past that point means this member is genuinely unreachable.
      try {
        const bundle = await claimPeerPrekeyBundle(memberId);
        establishSession(memberId, bundle.deviceId, bundle);
        perMember[memberId] = encryptMessage(memberId, REMOTE_DEVICE_ID, plaintext);
      } catch (error) {
        console.error('[sendToGroup] skipping unreachable member', memberId, error);
      }
    }
  }

  if (recipients.length === 0) {
    // A group with nobody else in it. Distinct from "everyone is
    // unreachable": there is nothing wrong, the group is simply empty, and
    // the caller can say something useful instead of reporting a failure.
    throw new EmptyGroupError();
  }

  if (Object.keys(perMember).length === 0) {
    throw new Error('No group member could be reached');
  }

  return sendPackedMessage(
    channelId,
    packGroupMessage(selfUserId, perMember),
    ttlSeconds,
    options,
  );
}
