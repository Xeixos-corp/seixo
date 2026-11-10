import { encryptMessage, establishSession, type EncryptedEnvelope } from '../crypto';
import { claimPeerPrekeyBundle } from '../transport/identities';

const REMOTE_DEVICE_ID = 1;

/**
 * libsignal's SessionNotFound, as it reaches JS: a plain protocol error whose
 * text is "session with <address> not found: <operation>" (or "session not
 * found: ..." when libsignal had no address to name). Matched on the text
 * because the native module folds every protocol error into one code; only the changed
 * identity gets its own (see crypto/index.ts::isUntrustedIdentityError).
 */
function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return MISSING_SESSION.test(message);
}

const MISSING_SESSION = /session( with \S+)? not found/i;

/** One establishment per peer at a time; see below. */
const establishing = new Map<string, Promise<void>>();

/**
 * Encrypts for a direct conversation, starting the Signal session first if
 * this phone has none with the peer yet.
 *
 * Only the person who starts a conversation gets a session on the way in
 * (startConversation.ts). The other one used to have none until the first
 * message arrived, so writing first failed every time and left a row of
 * "not sent" marks. Now that side claims the peer's prekey bundle, exactly
 * as groups already do for a member with no session (sendToGroup.ts). Both
 * ends starting a session at once is fine: libsignal keeps both and settles
 * on whichever is used, as packages/demo-account/tests/interop.rs shows.
 *
 * Only a missing session is repaired. A changed identity is rethrown
 * untouched: establishing past it would silently accept the new key, which is
 * exactly what the safety warning exists to stop.
 *
 * Two sends in quick succession share one establishment rather than claiming
 * two of the peer's one-time prekeys and replacing the first session with the
 * second.
 */
export async function encryptForPeer(peerUserId: string, plaintext: string): Promise<EncryptedEnvelope> {
  try {
    return encryptMessage(peerUserId, REMOTE_DEVICE_ID, plaintext);
  } catch (error) {
    if (!isMissingSessionError(error)) throw error;
  }

  let pending = establishing.get(peerUserId);
  if (!pending) {
    pending = (async () => {
      const bundle = await claimPeerPrekeyBundle(peerUserId);
      establishSession(peerUserId, bundle.deviceId, bundle);
    })().finally(() => establishing.delete(peerUserId));
    establishing.set(peerUserId, pending);
  }
  await pending;
  return encryptMessage(peerUserId, REMOTE_DEVICE_ID, plaintext);
}
