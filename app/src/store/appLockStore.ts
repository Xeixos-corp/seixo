import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

type AppLockState = {
  /** User preference. Persisted -- it must survive restarts to be worth anything. */
  enabled: boolean;
  /**
   * Whether the current session has been unlocked. Deliberately NOT persisted:
   * an unlock must not survive the app being killed, or the lock would only
   * ever be asked for once.
   */
  unlocked: boolean;
  setEnabled: (enabled: boolean) => void;
  setUnlocked: (unlocked: boolean) => void;
};

export const useAppLockStore = create<AppLockState>()(
  persist(
    (set) => ({
      enabled: false,
      // Starts locked whenever `enabled` is true; AppLockGate flips this.
      unlocked: false,
      // Turning the lock on counts as being unlocked -- the user just proved
      // themselves to enable it, so asking again immediately is pure friction.
      setEnabled: (enabled) => set({ enabled, unlocked: true }),
      setUnlocked: (unlocked) => set({ unlocked }),
    }),
    {
      name: 'app-lock-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ enabled: state.enabled }),
    },
  ),
);
