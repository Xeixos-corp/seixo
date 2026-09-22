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
  /**
   * Whether a screen recording (or mirroring to another screen) shows Seixo
   * as black.
   *
   * On by default, as it always was. A switch because the person may have
   * a real reason to record their own screen -- the first one was App
   * Review asking for a recording of the app, which the app itself made
   * impossible. Screenshots are not affected on iOS: those cannot be
   * blocked, and inside a conversation they are announced instead.
   */
  hideFromScreenRecording: boolean;
  setHideFromScreenRecording: (hide: boolean) => void;
};

export const usePrivacyPreferencesStore = create<PrivacyPreferencesState>()(
  persist(
    (set) => ({
      showMessagePreviews: true,
      setShowMessagePreviews: (show) => set({ showMessagePreviews: show }),
      hideFromScreenRecording: true,
      setHideFromScreenRecording: (hide) => set({ hideFromScreenRecording: hide }),
    }),
    {
      name: 'privacy-preferences',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
