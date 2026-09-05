import { create } from 'zustand';

type SecurityWarningsState = {
  /** Channels where a peer's identity key stopped matching what we had seen. */
  untrustedByChannel: Record<string, boolean>;
  markUntrusted: (channelId: string) => void;
  clearUntrusted: (channelId: string) => void;
};

// Deliberately not persisted: this reflects what happened during the current
// session's decrypt attempts, and should be re-derived rather than remembered
// across restarts.
//
// It exists because decryption moved out of ConversationScreen (see
// messaging/ingest.ts): messages are now decrypted as they arrive, whether or
// not their conversation is open, so the screen is no longer the thing that
// notices an identity-key change. Without somewhere shared to record it, that
// warning -- the equivalent of Signal's "safety number changed" -- would be
// lost whenever the message arrived while the user was looking elsewhere.
export const useSecurityWarningsStore = create<SecurityWarningsState>((set) => ({
  untrustedByChannel: {},
  markUntrusted: (channelId) =>
    set((state) => ({ untrustedByChannel: { ...state.untrustedByChannel, [channelId]: true } })),
  clearUntrusted: (channelId) =>
    set((state) => {
      const next = { ...state.untrustedByChannel };
      delete next[channelId];
      return { untrustedByChannel: next };
    }),
}));
