import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * How the app is unlocked.
 *
 * 'device': Face ID, falling back to the iPhone's passcode. The iPhone does
 * the checking, and Seixo only hears yes or no.
 *
 * 'code': a six-digit code of Seixo's own (security/lockCode.ts). It exists
 * for the panic code: only a code the app checks itself can have a second
 * one that means "wipe". With Face ID in front of it the panic code would be
 * pointless -- anyone forcing the phone open would simply hold it up to your
 * face -- so this mode offers no Face ID at all.
 */
export type AppLockMethod = 'device' | 'code';

type AppLockState = {
  /** User preference. Persisted -- it must survive restarts to be worth anything. */
  enabled: boolean;
  method: AppLockMethod;
  /**
   * Whether the current session has been unlocked. Deliberately NOT persisted:
   * an unlock must not survive the app being killed, or the lock would only
   * ever be asked for once.
   */
  unlocked: boolean;
  setEnabled: (enabled: boolean) => void;
  setMethod: (method: AppLockMethod) => void;
  setUnlocked: (unlocked: boolean) => void;
};

export const useAppLockStore = create<AppLockState>()(
  persist(
    (set) => ({
      enabled: false,
      // Every lock set before codes existed was a Face ID lock.
      method: 'device',
      // Starts locked whenever `enabled` is true; AppLockGate flips this.
      unlocked: false,
      // Turning the lock on counts as being unlocked -- the user just proved
      // themselves to enable it, so asking again immediately is pure friction.
      setEnabled: (enabled) => set({ enabled, unlocked: true }),
      setMethod: (method) => set({ method, unlocked: true }),
      setUnlocked: (unlocked) => set({ unlocked }),
    }),
    {
      name: 'app-lock-store',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ enabled: state.enabled, method: state.method }),
    },
  ),
);
