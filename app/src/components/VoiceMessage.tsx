import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { useTranslation } from 'react-i18next';
import { materialiseForPlayback, discard } from '../audio/voiceFiles';
import { claimPlayback, releasePlayback } from '../audio/playbackRegistry';

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Plays a voice message, writing the audio out only for as long as it is
 * being played.
 *
 * The file is created when playback starts and deleted the moment it stops,
 * rather than being kept for the next tap. Caching it would be faster and
 * would leave decrypted audio sitting in the app's cache after the message
 * itself had expired -- see audio/voiceFiles.ts.
 */
export function VoiceMessage({
  messageId,
  audioBase64,
  durationMs,
  tint,
  onLongPress,
}: {
  messageId: string;
  audioBase64: string;
  durationMs?: number;
  tint: string;
  /**
   * Forwarded from the bubble. A Pressable swallows gestures from the one
   * beneath it, and this button covers nearly the whole voice bubble -- so
   * without this there is nowhere left to long-press, and a voice message
   * could not be deleted or replied to at all.
   */
  onLongPress?: () => void;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  const uriRef = useRef<string | null>(null);
  // Synchronous, unlike `playing`. Two taps in the same tick both saw the old
  // state and each started a player, so you heard the message twice at once.
  const busyRef = useRef(false);

  const stop = useCallback(() => {
    const player = playerRef.current;
    playerRef.current = null;
    if (player) {
      // pause() before remove(). remove() releases the object but does not
      // reliably silence what is already playing -- which is why the stop
      // button appeared to do nothing.
      try {
        player.pause();
      } catch {
        // Already gone; nothing to silence.
      }
      player.remove();
    }
    if (uriRef.current) {
      void discard(uriRef.current);
      uriRef.current = null;
    }
    busyRef.current = false;
    releasePlayback(stop);
    setPlaying(false);
  }, []);

  // Also covers leaving the screen mid-playback, which would otherwise leave
  // both the sound and the decrypted file behind.
  useEffect(() => stop, [stop]);

  const toggle = useCallback(async () => {
    if (playing || busyRef.current) {
      stop();
      return;
    }
    busyRef.current = true;
    try {
      // Recording puts iOS into a mode that routes playback to the earpiece at
      // low volume; leaving it there after a recording makes every later
      // message sound broken.
      await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });

      const uri = await materialiseForPlayback(messageId, audioBase64);
      uriRef.current = uri;
      const player = createAudioPlayer(uri);
      playerRef.current = player;
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) stop();
      });
      claimPlayback(stop);
      player.play();
      setPlaying(true);
    } catch (error) {
      console.error('[voice] playback failed', error);
      stop();
    }
  }, [playing, stop, messageId, audioBase64]);

  return (
    <Pressable onPress={toggle} onLongPress={onLongPress} delayLongPress={350} style={styles.row} hitSlop={6}>
      <Text style={[styles.icon, { color: tint }]}>{playing ? '\u25A0' : '\u25B6'}</Text>
      <Text style={[styles.label, { color: tint }]}>
        {durationMs ? formatDuration(durationMs) : t('conversation.voiceMessage')}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 2,
  },
  icon: {
    fontSize: 16,
  },
  label: {
    fontSize: 15,
    fontVariant: ['tabular-nums'],
  },
});
