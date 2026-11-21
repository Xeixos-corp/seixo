import { create } from 'zustand';

type PendingInviteState = {
  /** An invite code that arrived through a link and has not been answered yet. */
  code: string | null;
  setCode: (code: string) => void;
  take: () => string | null;
};

/**
 * Holds an invite that arrived through a link until the conversation list
 * can ask about it: after onboarding when the app was just installed, or at
 * once when it was not.
 *
 * Memory only, like a shared link: an invite the person did not answer is
 * theirs to tap again, not something to keep on disk.
 */
export const usePendingInviteStore = create<PendingInviteState>()((set, get) => ({
  code: null,
  setCode: (code) => set({ code }),
  take: () => {
    const code = get().code;
    set({ code: null });
    return code;
  },
}));
