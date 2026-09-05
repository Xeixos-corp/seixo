import { decryptMessage, isUntrustedIdentityError } from '../crypto';
import { useMessagesStore } from '../store/messagesStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import type { FetchedMessage } from '../transport/messages';

const REMOTE_DEVICE_ID = 1; // single device per identity for now

/**
 * Messages that could not be decrypted this session, so they are not tried
 * again and again.
 *
 * This became a real problem the moment ingest moved out of ConversationScreen
 * (see below): decryption used to be attempted only while a conversation was
 * open, but the global sync re-fetches every conversation, so an undecryptable
 * message was retried on every single catch-up -- 15 identical failures in one
 * short session on the test device, all for the same three messages whose
 * sender had changed identity key.
 *
 * Deliberately in memory rather than persisted. Some failures really are
 * permanent (a changed identity key stays changed until the user accepts it),
 * but others may not be, and a restart is a cheap, natural moment to try once
 * more. This bounds the noise to one attempt per message per launch instead of
 * one per fetch, without permanently writing off a message that might yet be
 * readable.
 */
const failedThisSession = new Set<string>();

/** Called when the account is deleted -- nothing should outlive that. */
export function clearFailedMessageCache(): void {
  failedThisSession.clear();
}

/**
 * Decrypts an incoming message and records it locally.
 *
 * This used to live inside ConversationScreen, which meant messages were only
 * ever decrypted while their conversation was on screen. Anything that arrived
 * while the user was in the list, in another conversation, or had the app
 * closed simply sat on the server until they happened to open that
 * conversation -- so there was no way for the app to know it had unread
 * messages, and no way to notify about them.
 *
 * Safe to call from several places: every path that could deliver the same row
 * twice (an initial fetch racing the realtime insert) is de-duplicated by id
 * below, and all of it is synchronous, so two callers cannot interleave
 * between the check and the decrypt.
 */
export function ingestFetchedMessage(
  channelId: string,
  peerUserId: string,
  fetched: FetchedMessage,
): void {
  // Normally unreachable -- blocking removes the conversation -- but a
  // realtime event could arrive in the gap before that completes.
  if (useBlockedPeersStore.getState().isBlocked(peerUserId)) return;

  // Decrypting consumes a one-time Double Ratchet message key, so the same
  // ciphertext can never be decrypted twice. Anything already known must be
  // skipped, or the ratchet desyncs.
  const alreadyKnown = useMessagesStore
    .getState()
    .messagesByChannel[channelId]?.some((message) => message.id === fetched.id);
  if (alreadyKnown) return;

  if (failedThisSession.has(fetched.id)) return;

  // Already expired: not worth spending the one-time key on something that is
  // about to be discarded anyway.
  if (new Date(fetched.expiresAt).getTime() <= Date.now()) return;

  try {
    const plaintext = decryptMessage(peerUserId, REMOTE_DEVICE_ID, fetched.envelope);
    useMessagesStore.getState().addMessage(channelId, {
      id: fetched.id,
      createdAt: fetched.createdAt,
      expiresAt: fetched.expiresAt,
      plaintext,
      isMine: false,
    });
  } catch (error) {
    failedThisSession.add(fetched.id);
    if (isUntrustedIdentityError(error)) {
      useSecurityWarningsStore.getState().markUntrusted(channelId);
    }
    console.error('[ingest] failed to decrypt message', fetched.id, error);
  }
}
