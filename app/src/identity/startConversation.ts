import { DEFAULT_TTL_SECONDS, useConversationsStore, type Conversation } from '../store/conversationsStore';
import { registerIdentity } from './registerIdentity';
import { createDirectChannel } from '../transport/channels';
import { claimPeerPrekeyBundle } from '../transport/identities';
import { establishSession } from '../crypto';

/** Thrown by startConversationWithPeer when peerUserId is the caller's own id. */
export class SelfConversationError extends Error {}

/**
 * Shared by the manual "type a user_id" flow (ConversationListScreen.tsx)
 * and the QR scan flow (ScanQrScreen.tsx) — both end up wanting the exact
 * same sequence (create channel, claim prekey bundle, establish session,
 * record locally), so this exists once instead of twice.
 */
export async function startConversationWithPeer(peerUserId: string): Promise<Conversation> {
  const { userId } = await registerIdentity();
  if (peerUserId === userId) {
    throw new SelfConversationError();
  }

  const channelId = await createDirectChannel(peerUserId);
  const bundle = await claimPeerPrekeyBundle(peerUserId);
  establishSession(peerUserId, bundle.deviceId, bundle);

  const conversation: Conversation = {
    channelId,
    peerUserId,
    ttlSeconds: DEFAULT_TTL_SECONDS,
  };
  useConversationsStore.getState().addConversation(conversation);
  return conversation;
}
