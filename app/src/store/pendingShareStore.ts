import { create } from 'zustand';

type PendingShareState = {
  /** Text or link shared into Seixo from another app, not yet placed anywhere. */
  text: string | null;
  setText: (text: string) => void;
  clear: () => void;
};

/**
 * Holds something shared from the iOS share sheet between the moment it
 * arrives and the moment the person chooses a conversation for it.
 *
 * Deliberately not persisted. A shared link is the person's to place, and
 * keeping it on disk would leave it behind after they changed their mind --
 * in an app whose whole premise is that things do not linger.
 */
export const usePendingShareStore = create<PendingShareState>()((set) => ({
  text: null,
  setText: (text) => set({ text }),
  clear: () => set({ text: null }),
}));
