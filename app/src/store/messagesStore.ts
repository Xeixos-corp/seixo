import { create } from 'zustand';

export type DecryptedMessage = {
  id: string;
  createdAt: string;
  expiresAt: string;
  plaintext: string;
};

type MessagesState = {
  messagesByChannel: Record<string, DecryptedMessage[]>;
  addMessage: (channelId: string, message: DecryptedMessage) => void;
  removeMessage: (channelId: string, id: string) => void;
};

// Deliberately NOT persisted (no zustand/middleware persist here). Each
// entry only exists because decryptMessage() was called on it, which
// consumes a Double Ratchet message key — the same ciphertext can't be
// decrypted twice. Keeping this in memory only, and de-duplicating by id,
// avoids ever attempting a second decrypt of an already-seen message
// (e.g. if fetchMessages() and a realtime INSERT both deliver the same row).
export const useMessagesStore = create<MessagesState>((set, get) => ({
  messagesByChannel: {},
  addMessage: (channelId, message) => {
    const existing = get().messagesByChannel[channelId] ?? [];
    if (existing.some((m) => m.id === message.id)) {
      return;
    }
    set((state) => ({
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: [...existing, message],
      },
    }));
  },
  // Local-side disappearing-message removal (ConversationScreen schedules
  // this for each message's expiresAt) — separate from, and in addition to,
  // the server-side pg_cron purge (supabase/migrations/0002_pg_cron_ttl.sql).
  removeMessage: (channelId, id) => {
    const existing = get().messagesByChannel[channelId];
    if (!existing) return;
    set((state) => ({
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: existing.filter((m) => m.id !== id),
      },
    }));
  },
}));
