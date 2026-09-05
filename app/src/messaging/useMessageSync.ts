import { useEffect } from 'react';
import { useConversationsStore } from '../store/conversationsStore';
import { useMessagesStore } from '../store/messagesStore';
import { fetchMessages, subscribeToChannelMessages } from '../transport/messages';
import { ingestFetchedMessage } from './ingest';

/**
 * Keeps every conversation up to date, not just the one on screen.
 *
 * Fetching and subscribing used to live inside ConversationScreen, so a
 * message only reached this device when its conversation happened to be open.
 * Anything that arrived while the user was elsewhere stayed on the server,
 * which meant the app could not tell which conversations had unread messages
 * -- and would have had nothing to show if a push notification woke it.
 *
 * Mounted once, in App.tsx.
 */
export function useMessageSync(): void {
  const conversations = useConversationsStore((state) => state.conversations);

  // Resubscribe only when the set of channels actually changes. Depending on
  // the conversations array itself would tear down and rebuild every
  // subscription on any unrelated change to it -- renaming a contact, or
  // marking one read, which happens constantly.
  const channelKey = conversations
    .map((conversation) => `${conversation.channelId}:${conversation.peerUserId}`)
    .sort()
    .join(',');

  useEffect(() => {
    // Read fresh rather than closing over `conversations`, so this effect
    // does not need it as a dependency.
    const current = useConversationsStore.getState().conversations;

    const unsubscribers = current.map(({ channelId, peerUserId }) => {
      // Catch up on anything that arrived while this device was away. The
      // realtime subscription below only covers what happens from now on.
      fetchMessages(channelId)
        .then((fetched) => {
          fetched.forEach((message) => ingestFetchedMessage(channelId, peerUserId, message));
        })
        .catch((error) => {
          console.error('[messageSync] catch-up fetch failed', channelId, error);
        });

      return subscribeToChannelMessages(
        channelId,
        (message) => ingestFetchedMessage(channelId, peerUserId, message),
        (messageId) => useMessagesStore.getState().removeMessage(channelId, messageId),
      );
    });

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [channelKey]);
}
