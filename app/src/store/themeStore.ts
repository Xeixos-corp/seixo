import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemePreference = 'system' | 'light' | 'dark';

type ThemeState = {
  preference: ThemePreference;
  setPreference: (preference: ThemePreference) => void;
};

/**
 * Which appearance the user asked for.
 *
 * The default is 'light' rather than 'system': the app should look the same
 * to everybody the first time it is opened, and light is the face it was
 * designed around. Following the phone would mean a good part of new users
 * meeting a screen nobody chose for them.
 *
 * 'system' is still there, one tap away in Settings, along with 'dark' --
 * which in this app is not only a matter of taste: it is how you read in the
 * dark without a bright screen announcing that you are reading something.
 *
 * Only new installs are affected. Anyone who already has the app has
 * 'system' written in storage and keeps following their phone, which is what
 * they have been doing all along and never asked to change.
 */
export const useThemeStore = create<ThemeState>()(
  persist(
    (set) => ({
      preference: 'light',
      setPreference: (preference) => set({ preference }),
    }),
    {
      name: 'theme-store',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
