import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

type PrivacyPreferencesState = {
  /**
   * Whether the conversation list shows the last message under each name.
   *
   * On by default, because it is how people find a conversation. Offered as a
   * switch because the list is exactly what someone looking over your shoulder
   * sees first. Nothing about this leaves the phone either way: the preview is
   * built from messages already decrypted here, and notifications on the lock
   * screen stay generic regardless.
   */
  showMessagePreviews: boolean;
  setShowMessagePreviews: (show: boolean) => void;
};

export const usePrivacyPreferencesStore = create<PrivacyPreferencesState>()(
  persist(
    (set) => ({
      showMessagePreviews: true,
      setShowMessagePreviews: (show) => set({ showMessagePreviews: show }),
    }),
    {
      name: 'privacy-preferences',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
