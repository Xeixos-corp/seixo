import React, { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { createAudioPlayer, type AudioPlayer } from 'expo-audio';
import { useTranslation } from 'react-i18next';
import { materialiseForPlayback, discard } from '../audio/voiceFiles';

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
}: {
  messageId: string;
  audioBase64: string;
  durationMs?: number;
  tint: string;
}) {
  const { t } = useTranslation();
  const [playing, setPlaying] = useState(false);
  const playerRef = useRef<AudioPlayer | null>(null);
  const uriRef = useRef<string | null>(null);

  const cleanUp = React.useCallback(() => {
    playerRef.current?.remove();
    playerRef.current = null;
    if (uriRef.current) {
      void discard(uriRef.current);
      uriRef.current = null;
    }
    setPlaying(false);
  }, []);

  // Also covers leaving the screen mid-playback, which would otherwise leave
  // the decrypted file behind.
  useEffect(() => cleanUp, [cleanUp]);

  const toggle = async () => {
    if (playing) {
      cleanUp();
      return;
    }
    try {
      const uri = await materialiseForPlayback(messageId, audioBase64);
      uriRef.current = uri;
      const player = createAudioPlayer(uri);
      playerRef.current = player;
      player.addListener('playbackStatusUpdate', (status) => {
        if (status.didJustFinish) cleanUp();
      });
      player.play();
      setPlaying(true);
    } catch (error) {
      console.error('[voice] playback failed', error);
      cleanUp();
    }
  };

  return (
    <Pressable onPress={toggle} style={styles.row} hitSlop={6}>
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
