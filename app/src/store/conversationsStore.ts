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
};

type ConversationsState = {
  conversations: Conversation[];
  addConversation: (conversation: Conversation) => void;
  hasConversation: (channelId: string) => boolean;
  setConversationTtl: (channelId: string, ttlSeconds: number) => void;
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
    }),
    {
      name: 'conversations-store',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
