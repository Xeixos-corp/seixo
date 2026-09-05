import { decryptMessage, isUntrustedIdentityError } from '../crypto';
import { useMessagesStore } from '../store/messagesStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import type { FetchedMessage } from '../transport/messages';

const REMOTE_DEVICE_ID = 1; // single device per identity for now

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
    if (isUntrustedIdentityError(error)) {
      useSecurityWarningsStore.getState().markUntrusted(channelId);
    }
    console.error('[ingest] failed to decrypt message', fetched.id, error);
  }
}
