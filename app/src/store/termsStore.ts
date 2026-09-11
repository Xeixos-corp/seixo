import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

type TermsState = {
  /**
   * The version of the terms this device accepted, or null if none.
   *
   * A version rather than a boolean, so a significant change to the terms can
   * ask again simply by raising TERMS_VERSION (config/support.ts).
   *
   * Kept on the device only, deliberately. Recording acceptance on the server
   * would mean one more row per person that outlives every timer -- and it
   * proves nothing a reviewer needs, since an account cannot exist on this
   * device without passing the screen that asks.
   */
  acceptedVersion: number | null;
  accept: (version: number) => void;
};

export const useTermsStore = create<TermsState>()(
  persist(
    (set) => ({
      acceptedVersion: null,
      accept: (version) => set({ acceptedVersion: version }),
    }),
    {
      name: 'terms-store',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
