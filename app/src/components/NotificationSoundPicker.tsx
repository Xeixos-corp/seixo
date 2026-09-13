import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { NOTIFICATION_SOUNDS } from '../notifications/sounds';
import { useNotificationSoundStore } from '../store/notificationSoundStore';
import { updatePushSound } from '../notifications/pushTokens';
import { registerIdentity } from '../identity/registerIdentity';

/**
 * Picks the sound notifications play, and plays each one as it is picked.
 *
 * The preview matters more than it looks: the sound that arrives is played by
 * iOS from a file inside the app, so there is no other way to find out what
 * you chose short of asking somebody to message you.
 *
 * Choosing has to reach the server, because the server writes the push and
 * names the sound in it. The local choice is kept either way -- it is re-sent
 * with the push token on every launch -- so a failure here is worth saying
 * out loud but is not worth refusing the change over.
 */
export function NotificationSoundPicker() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const sound = useNotificationSoundStore((state) => state.sound);
  const setSound = useNotificationSoundStore((state) => state.setSound);
  const [error, setError] = useState<string | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  const stopPreview = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (!player) return;
    try {
      player.pause();
    } catch {
      // Already gone; nothing to stop.
    }
    player.remove();
  }, []);

  // Leaving the screen mid-preview would otherwise leave the player alive.
  useEffect(() => stopPreview, [stopPreview]);

  const preview = useCallback(
    async (asset: number | null) => {
      stopPreview();
      if (asset === null) return;
      try {
        // Recording leaves iOS routing audio to the earpiece; and a phone on
        // silent would play nothing at all, which for someone auditioning a
        // sound is indistinguishable from a broken app.
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        const player = createAudioPlayer(asset);
        playerRef.current = player;
        player.play();
      } catch (cause) {
        console.warn('[sounds] preview failed', cause);
      }
    },
    [stopPreview],
  );

  const choose = async (file: string, asset: number | null) => {
    setError(null);
    setSound(file);
    void preview(asset);
    try {
      const { userId } = await registerIdentity();
      await updatePushSound(userId, file);
    } catch (cause) {
      console.warn('[sounds] could not tell the server', cause);
      setError(t('settings.sounds.saveFailed'));
    }
  };

  return (
    <View style={styles.list}>
      {NOTIFICATION_SOUNDS.map(({ file, labelKey, asset }) => {
        const selected = sound === file;
        return (
          <Pressable
            key={file}
            onPress={() => void choose(file, asset)}
            style={({ pressed }) => [
              styles.row,
              {
                borderColor: selected ? colors.accent : colors.border,
                backgroundColor: pressed ? colors.surfaceAlt : 'transparent',
              },
            ]}
          >
            <Text style={[styles.label, { color: colors.textPrimary }]}>
              {t(`settings.sounds.${labelKey}`)}
            </Text>
            {selected ? (
              <Text style={[styles.check, { color: colors.accent }]}>✓</Text>
            ) : null}
          </Pressable>
        );
      })}
      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        {t('settings.sounds.hint')}
      </Text>
      {error ? <Text style={[styles.hint, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  label: { fontSize: 15 },
  check: { fontSize: 16, fontWeight: '700' },
  hint: { fontSize: 12, lineHeight: 17, marginTop: 2 },
});
