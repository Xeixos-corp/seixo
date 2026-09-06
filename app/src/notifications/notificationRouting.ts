import { useConversationsStore, type Conversation } from '../store/conversationsStore';
import { useMessagesStore } from '../store/messagesStore';
import { navigationRef } from '../navigation/navigationRef';

/**
 * Opens the right conversation when a notification is tapped.
 *
 * Note what is *not* happening here: the notification carries no channel id.
 * The obvious implementation would put one in the push payload, but that
 * payload passes through Expo's push service and Apple's, so both would learn
 * which conversation each device belongs to -- enough, across many
 * notifications, to reconstruct who talks to whom. That is precisely the
 * metadata the sealed-sender design and
 * supabase/migrations/0010_push_notifications.sql go out of their way not to
 * create, and it would be careless to hand it to a third party for the sake of
 * a convenience. The device already knows which conversation has a new
 * message, so it works this out locally instead.
 *
 * The catch is timing: a tap can arrive before the app has finished fetching,
 * so there may be no unread message to find yet. Rather than giving up (and
 * dumping the user on the list), the request stays open for a few seconds and
 * is retried whenever messages change or the navigator becomes available.
 */
let openUntil = 0;

function newestUnread(): Conversation | null {
  const { conversations } = useConversationsStore.getState();
  const { messagesByChannel } = useMessagesStore.getState();

  let best: Conversation | null = null;
  let bestAt = 0;

  for (const conversation of conversations) {
    const since = conversation.lastReadAt ? Date.parse(conversation.lastReadAt) : 0;
    for (const message of messagesByChannel[conversation.channelId] ?? []) {
      if (message.isMine === true) continue;
      const at = Date.parse(message.createdAt);
      if (at > since && at > bestAt) {
        bestAt = at;
        best = conversation;
      }
    }
  }
  return best;
}

/** Retried from several places; safe to call at any time. */
export function tryOpenPendingConversation(): void {
  if (openUntil === 0 || Date.now() > openUntil) return;
  if (!navigationRef.isReady()) return;

  const target = newestUnread();
  if (!target) return;

  openUntil = 0;
  navigationRef.navigate('Conversation', {
    channelId: target.channelId,
    peerUserId: target.peerUserId,
  });
}

export function requestOpenNewestUnread(windowMs = 8000): void {
  openUntil = Date.now() + windowMs;
  tryOpenPendingConversation();
}

// Messages arriving is the event most likely to make a pending request
// satisfiable, since the usual reason it cannot be satisfied yet is that the
// catch-up fetch has not returned.
useMessagesStore.subscribe(() => {
  tryOpenPendingConversation();
});
