import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

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

// Persisted, as of 2026-09-05. This used to be in-memory only, which meant
// every conversation was wiped whenever the app was closed — and
// unrecoverably so: decryptMessage() consumes a Double Ratchet message key,
// so the ciphertext still sitting on the server can never be decrypted a
// second time. The plaintext held here is the only copy that will ever
// exist. In-memory-only was defensible as "nothing legible on disk", but it
// stopped this being a messenger at all, and an app nobody can use protects
// nobody.
//
// What that costs, stated plainly: decrypted message text is now on disk.
// On iOS it sits in the app container, which the OS encrypts at rest and
// ties to the device passcode; it is not additionally encrypted by this app.
// The threat model's "compromised endpoint device, unlocked" case was
// already out of scope, and an app lock (Face ID / passcode) is landing
// separately to cover the casual "someone picks up my unlocked phone" case.
//
// Expired messages are dropped during hydration (see `merge` below) rather
// than resurrected on launch — otherwise restarting the app would undo
// disappearing messages, which would be a real break of a promise the app
// makes.
//
// De-duplication by id still matters for the original reason: fetchMessages()
// and a realtime INSERT can both deliver the same row, and decrypting twice
// would desync the ratchet.
export const useMessagesStore = create<MessagesState>()(
  persist(
    (set, get) => ({
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
    }),
    {
      name: 'messages-store',
      storage: createJSONStorage(() => AsyncStorage),
      // Drop anything that expired while the app was closed. Without this,
      // a message with a 30-second timer would come back from the dead on
      // the next launch.
      merge: (persisted, current) => {
        const stored = (persisted as Partial<MessagesState> | undefined)?.messagesByChannel ?? {};
        const now = Date.now();
        const alive: Record<string, DecryptedMessage[]> = {};

        for (const [channelId, messages] of Object.entries(stored)) {
          const unexpired = messages.filter((m) => new Date(m.expiresAt).getTime() > now);
          if (unexpired.length > 0) {
            alive[channelId] = unexpired;
          }
        }

        return { ...current, messagesByChannel: alive };
      },
    },
  ),
);
