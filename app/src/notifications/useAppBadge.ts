import { useEffect, useMemo, useRef } from 'react';
import { AppState } from 'react-native';
import Constants from 'expo-constants';
import { setBadgeCount } from '../../modules/shared-badge-expo/src';
import { useConversationsStore, unreadCount } from '../store/conversationsStore';
import { useMessagesStore } from '../store/messagesStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';

/**
 * The App Group shared with the Notification Service Extension, set per build
 * variant in app.config.js. Undefined on a build without it, in which case
 * the badge is simply left alone.
 */
const APP_GROUP: string | undefined = Constants.expoConfig?.extra?.appGroup;

/**
 * Keeps the number on the app icon equal to the unread messages on this
 * phone.
 *
 * Two halves make the badge work. While the app is closed, the Notification
 * Service Extension adds one per notification -- it cannot see messages, only
 * that a push arrived. While the app is open, this replaces that estimate with
 * the real count, computed from the same unread logic the conversation list
 * shows, and stores it for the extension to continue from.
 *
 * Nothing is sent anywhere: read state never leaves the phone, which is why
 * the server could not set this number itself.
 */
export function useAppBadge(): void {
  const conversations = useConversationsStore((state) => state.conversations);
  const messagesByChannel = useMessagesStore((state) => state.messagesByChannel);
  const blockedPeerIds = useBlockedPeersStore((state) => state.blockedPeerIds);

  // Blocked conversations are hidden from the list, so they must not add to
  // the badge either -- a number with nothing behind it reads as a bug.
  const total = useMemo(
    () =>
      conversations
        .filter((conversation) => !blockedPeerIds.includes(conversation.peerUserId))
        .reduce(
          (sum, conversation) => sum + unreadCount(conversation, messagesByChannel[conversation.channelId]),
          0,
        ),
    [conversations, messagesByChannel, blockedPeerIds],
  );

  const totalRef = useRef(total);
  totalRef.current = total;

  useEffect(() => {
    void setBadgeCount(total, APP_GROUP);
  }, [total]);

  // Written again on the way out, so the extension starts counting from the
  // number the person last saw rather than from one set minutes earlier.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active') void setBadgeCount(totalRef.current, APP_GROUP);
    });
    return () => subscription.remove();
  }, []);
}
