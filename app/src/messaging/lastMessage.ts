import type { DecryptedMessage } from '../store/messagesStore';

/**
 * The most recent message worth showing in a conversation, or null.
 *
 * Edits and reactions are instructions, not messages, and never count. Shared
 * by the conversation row (what it previews) and the list (how it orders), so
 * the row at the top is always the one whose preview is newest.
 */
export function lastVisibleMessage(messages: DecryptedMessage[] | undefined): DecryptedMessage | null {
  if (!messages?.length) return null;
  let latest: DecryptedMessage | null = null;
  for (const message of messages) {
    if (message.isControl) continue;
    if (!latest || Date.parse(message.createdAt) > Date.parse(latest.createdAt)) latest = message;
  }
  return latest;
}
