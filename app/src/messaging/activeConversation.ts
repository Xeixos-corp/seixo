import { useConversationsStore, unreadCount } from '../store/conversationsStore';
import { useMessagesStore } from '../store/messagesStore';

/**
 * Which conversation is on screen, if any.
 *
 * Exists so an arriving notification can be suppressed when the user is
 * already looking at the conversation it came from. The server cannot make
 * that decision: it does not know what is on screen, and the notification
 * deliberately does not say which conversation it belongs to -- putting a
 * channel id in a payload that passes through Expo and Apple would hand them
 * the shape of who talks to whom, which is exactly what the rest of the
 * design avoids. So the phone works it out from what it already knows.
 */
let activeChannelId: string | null = null;

export function setActiveConversation(channelId: string | null): void {
  activeChannelId = channelId;
}

export function getActiveConversation(): string | null {
  return activeChannelId;
}

/**
 * Whether anything is unread outside the conversation currently on screen.
 *
 * This is how a foreground notification is judged without knowing where it
 * came from. If the only unread messages are in the conversation being read,
 * there is nothing to announce. If something is unread elsewhere, the
 * notification is worth showing -- it may well be about that.
 *
 * It relies on the message arriving over the realtime socket before the push
 * does, which is normally true (one is a direct connection, the other goes
 * via Apple). When it isn't, the worst case is a notification for a
 * conversation already open -- the behaviour we have today.
 */
export function hasUnreadOutsideActiveConversation(): boolean {
  const active = activeChannelId;
  if (!active) return true;

  const { conversations } = useConversationsStore.getState();
  const { messagesByChannel } = useMessagesStore.getState();

  return conversations.some(
    (conversation) =>
      conversation.channelId !== active &&
      unreadCount(conversation, messagesByChannel[conversation.channelId]) > 0,
  );
}
