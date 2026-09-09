import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type DecryptedMessage = {
  id: string;
  createdAt: string;
  expiresAt: string;
  plaintext: string;
  /**
   * Whether this device sent it. Set at the point we know for certain —
   * true in handleSend, false in decryptAndStore — rather than derived
   * later, because nothing in the ciphertext or the row identifies a
   * sender: `messages` has no sender_id column by design (not sealed sender --
   * see docs/threat-model.md's correction of that term;
   * supabase/migrations/0001_init.sql).
   *
   * Optional because messages persisted before this field existed have no
   * value for it. Those render in the old neutral style rather than being
   * guessed at and attributed to the wrong person.
   */
  isMine?: boolean;
  /**
   * Id of the message this one replies to, when it is a reply.
   *
   * Only the id: the quoted text is looked up locally at render time rather
   * than copied in here, so a quote can never outlive the message it quotes.
   * See messaging/payload.ts.
   */
  replyToId?: string;
  /**
   * Delivery state of a message this device is sending. Undefined on
   * received messages, and on ones sent before this field existed -- both
   * render without any indicator rather than claiming a state we don't know.
   *
   * This is "did the server accept it", nothing more. It says nothing about
   * whether the other person received or read it; that would need them to
   * send something back, which is a separate decision with its own metadata
   * cost (see docs/threat-model.md).
   */
  status?: 'sending' | 'sent' | 'failed';
  /**
   * When the text was last changed, if it ever was. Shown next to the time.
   *
   * Marking edits is not decoration. A message whose text can change silently
   * is a message nobody can rely on having read -- the person you are talking
   * to could rewrite what they said and you would have no way to tell. Every
   * messenger that allows editing shows this, and it is the thing that makes
   * editing safe to offer at all.
   */
  editedAt?: string;
  /**
   * Set on an edit that arrived before the message it replaces, and so had to
   * stand in for it. Keeps the original from being added again underneath when
   * it finally turns up.
   */
  supersedesId?: string;
  /**
   * Emoji reactions on this message, keyed by who reacted: 'mine' for this
   * device, 'theirs' for the other person. One reaction each, replaced rather
   * than accumulated, which matches how people actually use them and keeps
   * the bubble from filling up.
   */
  reactions?: { mine?: string; theirs?: string };
  /**
   * A message that carried an instruction rather than something to read -- an
   * edit or a reaction. Kept only so that its id is remembered.
   *
   * Without this the id is nowhere, so the de-duplication check never
   * recognises it and every catch-up fetch decrypts it again -- which fails,
   * because a Double Ratchet message key works exactly once. Harmless but
   * noisy, and it repeats on every launch. Never rendered.
   */
  isControl?: boolean;
  /** Voice message: the recording, base64. `plaintext` is empty for these. */
  audioBase64?: string;
  audioDurationMs?: number;
  /**
   * Who sent it, in a group. Undefined in a one-to-one conversation, where
   * `isMine` already says everything there is to say.
   */
  senderUserId?: string;
};

type MessagesState = {
  messagesByChannel: Record<string, DecryptedMessage[]>;
  addMessage: (channelId: string, message: DecryptedMessage) => void;
  removeMessage: (channelId: string, id: string) => void;
  /**
   * Swaps a locally-created message for the server's version of it, keeping
   * its position. Used when a send succeeds: the row only gets its real id,
   * created_at and expires_at once the server has accepted it.
   */
  replaceMessage: (channelId: string, localId: string, message: DecryptedMessage) => void;
  setMessageStatus: (channelId: string, id: string, status: DecryptedMessage['status']) => void;
  /**
   * Rewrites a message's text in place, keeping its id, position and -- most
   * importantly -- its original expiry. Editing must not restart the
   * disappearing timer, or it would be a way to keep a message alive forever.
   */
  applyEdit: (channelId: string, targetId: string, text: string, editedAt: string) => boolean;
  /**
   * Sets or clears one side's reaction on a message. An empty emoji removes
   * it. Returns false when the target isn't here -- the caller decides what
   * that means (see messaging/ingest.ts).
   */
  applyReaction: (
    channelId: string,
    targetId: string,
    side: 'mine' | 'theirs',
    emoji: string,
  ) => boolean;
  /** Drops every message for a channel — used when leaving a conversation. */
  clearChannel: (channelId: string) => void;
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
      replaceMessage: (channelId, localId, message) => {
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: (state.messagesByChannel[channelId] ?? []).map((m) =>
              m.id === localId ? message : m,
            ),
          },
        }));
      },
      setMessageStatus: (channelId, id, status) => {
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: (state.messagesByChannel[channelId] ?? []).map((m) =>
              m.id === id ? { ...m, status } : m,
            ),
          },
        }));
      },
      applyEdit: (channelId, targetId, text, editedAt) => {
        const existing = get().messagesByChannel[channelId] ?? [];
        if (!existing.some((m) => m.id === targetId)) return false;
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: (state.messagesByChannel[channelId] ?? []).map((m) =>
              m.id === targetId ? { ...m, plaintext: text, editedAt } : m,
            ),
          },
        }));
        return true;
      },
      applyReaction: (channelId, targetId, side, emoji) => {
        const existing = get().messagesByChannel[channelId] ?? [];
        if (!existing.some((m) => m.id === targetId)) return false;
        set((state) => ({
          messagesByChannel: {
            ...state.messagesByChannel,
            [channelId]: (state.messagesByChannel[channelId] ?? []).map((m) => {
              if (m.id !== targetId) return m;
              const reactions = { ...(m.reactions ?? {}) };
              if (emoji) reactions[side] = emoji;
              else delete reactions[side];
              return {
                ...m,
                reactions: Object.keys(reactions).length > 0 ? reactions : undefined,
              };
            }),
          },
        }));
        return true;
      },
      clearChannel: (channelId) => {
        set((state) => {
          const next = { ...state.messagesByChannel };
          delete next[channelId];
          return { messagesByChannel: next };
        });
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
          const unexpired = messages
            .filter((m) => new Date(m.expiresAt).getTime() > now)
            // A message left mid-send when the app was killed is not still
            // sending -- nothing is sending it. Calling it failed is both
            // true and useful: failed messages can be retried, whereas one
            // stuck on "sending" forever can only be deleted.
            .map((m) => (m.status === 'sending' ? { ...m, status: 'failed' as const } : m));
          if (unexpired.length > 0) {
            alive[channelId] = unexpired;
          }
        }

        return { ...current, messagesByChannel: alive };
      },
    },
  ),
);
