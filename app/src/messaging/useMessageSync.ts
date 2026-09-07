import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';
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

  // Bumping this tears every subscription down and builds it again, refetching
  // as it goes. Two things do it, and both are cases where the connection can
  // be dead while looking alive:
  //
  //  - coming back to the foreground. iOS suspends the app in the background
  //    and the websocket does not always survive it. The symptom was precise:
  //    notifications kept arriving (the server sends those, by a route that
  //    has nothing to do with this socket) while the conversation stayed
  //    empty until it was closed and reopened -- reopening runs
  //    ConversationScreen's catch-up fetch, which is why it looked fixed.
  //
  //  - the subscription reporting itself unhealthy.
  const [epoch, setEpoch] = useState(0);
  const lastResyncRef = useRef(0);

  // Rate-limited, because a channel that fails repeatedly would otherwise
  // rebuild every subscription in a tight loop -- turning a dropped connection
  // into a much worse problem.
  const resync = useCallback((reason: string) => {
    const now = Date.now();
    if (now - lastResyncRef.current < 5000) return;
    lastResyncRef.current = now;
    console.log('[messageSync] resyncing:', reason);
    setEpoch((value) => value + 1);
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') resync('app returned to foreground');
    });
    return () => subscription.remove();
  }, [resync]);

  // Resubscribe only when the set of channels actually changes. Depending on
  // the conversations array itself would tear down and rebuild every
  // subscription on any unrelated change to it -- renaming a contact, or
  // marking one read, which happens constantly.
  const channelKey = conversations
    .map((conversation) => `${conversation.channelId}:${conversation.peerUserId}`)
    .sort()
    .join(',');

  useEffect(() => {
    // Tearing a subscription down makes Supabase report it as CLOSED, which
    // would call onUnhealthy and trigger another resync -- which would tear it
    // down again. The rate limit would slow that to a cycle every five
    // seconds rather than stopping it. This flag makes teardown silent, so
    // only a connection that dies while we still want it counts.
    let disposed = false;

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
        () => {
          if (!disposed) resync(`channel ${channelId} unhealthy`);
        },
      );
    });

    return () => {
      disposed = true;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [channelKey, epoch, resync]);
}
