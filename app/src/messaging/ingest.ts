import { decryptMessage, isUntrustedIdentityError } from '../crypto';
import { useMessagesStore } from '../store/messagesStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import { useConversationsStore } from '../store/conversationsStore';
import { decodePayload } from './payload';
import { decodeEnvelope } from '../crypto/messageCodec';
import { unpackGroupMessage, isGroupMessage } from './groupEnvelope';
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

/**
 * Records that a control message was handled, so it is not decrypted again.
 *
 * Edits and reactions are applied to another message rather than added to the
 * conversation, which left their ids unrecorded -- and the de-duplication
 * check works on ids. Every catch-up fetch would decrypt them afresh and fail,
 * because a message key is spent the first time. Storing a minimal, never
 * rendered row is enough to be recognised, and it expires with everything
 * else.
 */
function rememberControlMessage(channelId: string, fetched: FetchedMessage): void {
  useMessagesStore.getState().addMessage(channelId, {
    id: fetched.id,
    createdAt: fetched.createdAt,
    expiresAt: fetched.expiresAt,
    plaintext: '',
    isMine: false,
    isControl: true,
  });
}

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
  /**
   * Set for a group, where the sender is whoever the message says it is
   * rather than "the other person in this conversation". Passed in so this
   * function never has to guess which kind of channel it is looking at.
   */
  selfUserId?: string,
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

  // Who actually sent this, and which copy of it is ours. In a one-to-one
  // conversation both are trivially the other person; in a group the message
  // carries its sender and one envelope per member.
  let sender = peerUserId;
  let envelope;
  if (isGroupMessage(fetched.ciphertext)) {
    if (!selfUserId) return;
    const unpacked = unpackGroupMessage(fetched.ciphertext, selfUserId);
    // No copy addressed to this device: normal when someone joined between a
    // message being composed and sent. Nothing to decrypt and nothing wrong.
    if (!unpacked) return;
    // Own message coming back from the server; the local copy is already
    // shown, and there is no session with oneself to decrypt it with.
    if (unpacked.senderUserId === selfUserId) return;
    sender = unpacked.senderUserId;
    envelope = unpacked.envelope;
  } else {
    envelope = decodeEnvelope(fetched.ciphertext);
  }

  if (useBlockedPeersStore.getState().isBlocked(sender)) return;

  try {
    const raw = decryptMessage(sender, REMOTE_DEVICE_ID, envelope);
    const { text, replyToId, editsMessageId, reactsToMessageId, audioBase64, audioDurationMs, localTtlSeconds, groupName } =
      decodePayload(raw);

    // The row's expires_at is only how long the *server* held it. When the
    // sender asked for a longer life on the devices, that travels inside the
    // encryption and wins here.
    const expiresAt = localTtlSeconds
      ? new Date(Date.parse(fetched.createdAt) + localTtlSeconds * 1000).toISOString()
      : fetched.expiresAt;
    const store = useMessagesStore.getState();

    if (groupName !== undefined) {
      // Applied as the local name, the same field a nickname uses -- so a
      // name the owner chose and a name you gave a contact yourself are the
      // same thing to the rest of the app, and neither ever leaves the phone.
      useConversationsStore.getState().setConversationNickname(channelId, groupName);
      rememberControlMessage(channelId, fetched);
      return;
    }

    if (reactsToMessageId) {
      // A reaction is an annotation, not a message: it is never added to the
      // conversation itself. If the message it refers to is gone -- expired,
      // deleted, never received -- there is nothing to annotate and the
      // reaction is simply dropped. Unlike an edit, nothing is lost by that:
      // an emoji with no message to attach to means nothing on its own.
      store.applyReaction(channelId, reactsToMessageId, 'theirs', text);
      rememberControlMessage(channelId, fetched);
      return;
    }

    if (editsMessageId) {
      // Normal case: rewrite the message this replaces, in place, keeping its
      // original position and expiry.
      if (store.applyEdit(channelId, editsMessageId, text, fetched.createdAt)) {
        rememberControlMessage(channelId, fetched);
        return;
      }

      // The edit arrived before the message it edits -- possible when a
      // catch-up fetch and a realtime insert interleave. Standing in for the
      // missing original is better than dropping the text on the floor;
      // supersedesId stops the original being added underneath when it lands.
      store.addMessage(channelId, {
        id: fetched.id,
        createdAt: fetched.createdAt,
        expiresAt: fetched.expiresAt,
        plaintext: text,
        isMine: false,
        replyToId,
        editedAt: fetched.createdAt,
        supersedesId: editsMessageId,
      });
      return;
    }

    // A message that some already-received edit replaced. Adding it now would
    // show the superseded text below the corrected one.
    const alreadySuperseded = (store.messagesByChannel[channelId] ?? []).some(
      (message) => message.supersedesId === fetched.id,
    );
    if (alreadySuperseded) return;

    store.addMessage(channelId, {
      id: fetched.id,
      createdAt: fetched.createdAt,
      expiresAt,
      plaintext: text,
      isMine: false,
      replyToId,
      audioBase64,
      audioDurationMs,
      senderUserId: sender,
    });
  } catch (error) {
    failedThisSession.add(fetched.id);
    if (isUntrustedIdentityError(error)) {
      useSecurityWarningsStore.getState().markUntrusted(channelId);
    }
    console.error('[ingest] failed to decrypt message', fetched.id, error);
  }
}
