import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// Default per-message disappearing timer (1 day) for newly started
// conversations — the schema requires expires_at on every row regardless
// (supabase/migrations/0001_init.sql), so there's always *some* TTL; this is
// just the starting point before the user picks one in ConversationScreen.
export const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export type Conversation = {
  channelId: string;
  peerUserId: string;
  /** Disappearing-message timer applied to messages sent in this conversation. */
  ttlSeconds: number;
  /**
   * Local-only label for this peer, chosen by this user. Never sent anywhere:
   * the server only ever knows the opaque user_id, and naming a contact is
   * not something it should learn. Undefined until the user sets one.
   */
  nickname?: string;
};

/**
 * What to show for a conversation in the UI. Falls back to a shortened
 * user_id, because the full one is a 36-character UUID that tells a human
 * nothing -- the list used to render it raw, which made two contacts
 * genuinely hard to tell apart.
 */
export function conversationDisplayName(conversation: Conversation): string {
  const nickname = conversation.nickname?.trim();
  if (nickname) return nickname;
  return `${conversation.peerUserId.slice(0, 8)}…`;
}

type ConversationsState = {
  conversations: Conversation[];
  addConversation: (conversation: Conversation) => void;
  hasConversation: (channelId: string) => boolean;
  setConversationTtl: (channelId: string, ttlSeconds: number) => void;
  setConversationNickname: (channelId: string, nickname: string) => void;
  removeConversation: (channelId: string) => void;
};

// Persisted: the list of known conversations (including the chosen TTL)
// doesn't depend on Double Ratchet state, unlike message content (see
// messagesStore.ts) — it's safe to keep across restarts even though the
// messages inside will stop being decryptable once the in-memory
// SignalDevice is gone.
export const useConversationsStore = create<ConversationsState>()(
  persist(
    (set, get) => ({
      conversations: [],
      addConversation: (conversation) => {
        if (get().conversations.some((c) => c.channelId === conversation.channelId)) {
          return;
        }
        set((state) => ({ conversations: [...state.conversations, conversation] }));
      },
      hasConversation: (channelId) => get().conversations.some((c) => c.channelId === channelId),
      setConversationTtl: (channelId, ttlSeconds) => {
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.channelId === channelId ? { ...c, ttlSeconds } : c,
          ),
        }));
      },
      // Local-only rename. Trimming to empty clears it, so the display falls
      // back to the shortened user_id rather than showing a blank row.
      setConversationNickname: (channelId, nickname) => {
        const trimmed = nickname.trim();
        set((state) => ({
          conversations: state.conversations.map((c) =>
            c.channelId === channelId ? { ...c, nickname: trimmed || undefined } : c,
          ),
        }));
      },
      // Used when blocking a peer (ConversationScreen.tsx) — hides the
      // conversation locally. Doesn't touch server-side channel/message
      // rows; those age out via the existing TTL purge like any other
      // conversation (see supabase/migrations/0007_blocking.sql).
      removeConversation: (channelId) => {
        set((state) => ({
          conversations: state.conversations.filter((c) => c.channelId !== channelId),
        }));
      },
    }),
    {
      name: 'conversations-store',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
