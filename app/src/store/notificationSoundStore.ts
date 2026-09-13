import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { DEFAULT_SOUND, isKnownSound } from '../notifications/sounds';

type NotificationSoundState = {
  /** A file name from NOTIFICATION_SOUNDS, or 'default'. */
  sound: string;
  setSound: (sound: string) => void;
};

/**
 * Which sound this person's notifications play.
 *
 * Kept here as well as on the server because the server is what writes the
 * push payload and therefore has to know the name -- see
 * supabase/migrations/0025_notification_sound.sql. This copy is what Settings
 * renders, and what is re-sent with the push token on every launch, so the
 * two cannot drift for long.
 */
export const useNotificationSoundStore = create<NotificationSoundState>()(
  persist(
    (set) => ({
      sound: DEFAULT_SOUND,
      setSound: (sound) => set({ sound }),
    }),
    {
      name: 'notification-sound',
      storage: createJSONStorage(() => AsyncStorage),
      // A build that no longer ships a sound would otherwise keep asking for
      // a file that is not there, which on iOS means no sound at all and no
      // way to tell why.
      onRehydrateStorage: () => (state) => {
        if (state && !isKnownSound(state.sound)) state.setSound(DEFAULT_SOUND);
      },
    },
  ),
);
