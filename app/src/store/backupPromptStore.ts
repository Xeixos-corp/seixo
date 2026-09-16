import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/** A week. Long enough that there is something worth keeping. */
const REMIND_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

type BackupPromptState = {
  /** When this device first opened the app. Set once, never updated. */
  firstSeenAt: string | null;
  /** Set the moment a backup file is actually saved somewhere. */
  hasBackedUp: boolean;
  /** "Not now" was pressed. Asked once, never again. */
  dismissed: boolean;
  noteFirstSeen: () => void;
  markBackedUp: () => void;
  dismiss: () => void;
};

/**
 * Whether to mention the recovery backup, once.
 *
 * The FAQ says plainly that losing a phone with no backup means losing the
 * account, and that nobody can undo it. The app has never said so to anybody.
 * Someone who does not wander into Settings finds out at the only moment when
 * knowing is useless.
 *
 * Deliberately not at first launch. There is nothing to lose yet, nobody reads
 * anything on the first screen of a new app, and a plea for attention before
 * any value has been delivered is how apps train people to dismiss everything.
 * A week in, with at least one conversation, there is something to protect and
 * a reason to listen.
 *
 * And deliberately once. An app that keeps asking has decided its own priority
 * matters more than the answer it was given; "not now" is taken as an answer.
 */
export const useBackupPromptStore = create<BackupPromptState>()(
  persist(
    (set, get) => ({
      firstSeenAt: null,
      hasBackedUp: false,
      dismissed: false,
      noteFirstSeen: () => {
        if (get().firstSeenAt) return;
        set({ firstSeenAt: new Date().toISOString() });
      },
      markBackedUp: () => set({ hasBackedUp: true }),
      dismiss: () => set({ dismissed: true }),
    }),
    {
      name: 'backup-prompt',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

/**
 * Whether the reminder is due. Kept beside the state so the conditions are in
 * one place rather than spread through a screen.
 */
export function shouldOfferBackup(
  state: Pick<BackupPromptState, 'firstSeenAt' | 'hasBackedUp' | 'dismissed'>,
  conversationCount: number,
): boolean {
  if (state.hasBackedUp || state.dismissed) return false;
  if (conversationCount === 0) return false;
  if (!state.firstSeenAt) return false;
  return Date.now() - Date.parse(state.firstSeenAt) >= REMIND_AFTER_MS;
}
