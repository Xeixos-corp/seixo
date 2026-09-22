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
   * Off by default since 1.13.3, the owner's decision: App Review asked for a
   * recording of the app starting at first launch, and with this on the
   * whole recording came out black -- terms and welcome screen included --
   * with no way to turn it off before them. Signal ships the same way on
   * iOS: screen security is there for whoever wants it. Screenshots are not
   * affected either way: iOS cannot block them, and inside a conversation
   * they are announced instead.
   */
  hideFromScreenRecording: boolean;
  setHideFromScreenRecording: (hide: boolean) => void;
};

export const usePrivacyPreferencesStore = create<PrivacyPreferencesState>()(
  persist(
    (set) => ({
      showMessagePreviews: true,
      setShowMessagePreviews: (show) => set({ showMessagePreviews: show }),
      hideFromScreenRecording: false,
      setHideFromScreenRecording: (hide) => set({ hideFromScreenRecording: hide }),
    }),
    {
      name: 'privacy-preferences',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
