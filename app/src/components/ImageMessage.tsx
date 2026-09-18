import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { StoredImage } from '../store/messagesStore';
import { fetchImageInBackground, imageUri } from '../messaging/attachments';

/** Bubble size limits, in points. The picture keeps its proportions inside them. */
const MAX_WIDTH = 240;
const MAX_HEIGHT = 320;

type Props = {
  channelId: string;
  messageId: string;
  image: StoredImage;
  /** Colour for the status text drawn over the picture. */
  tint: string;
  onLongPress: () => void;
};

/**
 * One picture in a conversation.
 *
 * Shows, in order of what is available: the real picture; the tiny preview
 * that travelled inside the message, blurred, while the real one arrives; or,
 * when neither will ever come, a plain statement that it is unavailable. The
 * blurred preview is sized exactly like the picture it stands in for, so
 * nothing jumps when the real one replaces it.
 */
export function ImageMessage({ channelId, messageId, image, tint, onLongPress }: Props) {
  const { t } = useTranslation();
  const [viewing, setViewing] = useState(false);
  const [broken, setBroken] = useState(false);

  // A picture that is still owed and is now on screen: make sure something is
  // fetching it. Usually ingest already started it; this covers a fetch that
  // was lost, and is a no-op if one is already running.
  const pending = Boolean(image.keyBase64) && !image.fileName && image.state !== 'unavailable';
  useEffect(() => {
    if (pending && image.keyBase64) fetchImageInBackground(channelId, messageId, image.keyBase64);
  }, [pending, channelId, messageId, image.keyBase64]);

  const scale = Math.min(1, MAX_WIDTH / image.width, MAX_HEIGHT / image.height);
  const size = { width: Math.round(image.width * scale), height: Math.round(image.height * scale) };

  const unavailable = image.state === 'unavailable' || broken;
  const showFull = Boolean(image.fileName) && !broken;
  const status =
    image.state === 'uploading'
      ? t('conversation.imageSending')
      : image.state === 'failed'
        ? t('conversation.imageNotSent')
        : unavailable
          ? t('conversation.imageUnavailable')
          : null;

  return (
    <>
      <Pressable
        onPress={() => (showFull ? setViewing(true) : undefined)}
        onLongPress={onLongPress}
        delayLongPress={350}
        accessibilityRole="image"
        accessibilityLabel={t('conversation.imageLabel')}
      >
        <View style={[styles.frame, size]}>
          {showFull ? (
            <Image
              source={{ uri: imageUri(image.fileName as string) }}
              style={size}
              resizeMode="cover"
              // A file the cache was cleared of, or one that failed to decode.
              onError={() => setBroken(true)}
            />
          ) : image.previewBase64 && !unavailable ? (
            <Image
              source={{ uri: `data:image/jpeg;base64,${image.previewBase64}` }}
              style={size}
              resizeMode="cover"
              blurRadius={12}
            />
          ) : null}

          {status || (!showFull && !unavailable) ? (
            <View style={styles.overlay}>
              {!unavailable && image.state !== 'failed' ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : null}
              {status ? <Text style={[styles.status, { color: unavailable ? tint : '#FFFFFF' }]}>{status}</Text> : null}
            </View>
          ) : null}
        </View>
      </Pressable>

      {showFull ? (
        <FullScreenImage
          uri={imageUri(image.fileName as string)}
          visible={viewing}
          onClose={() => setViewing(false)}
        />
      ) : null}
    </>
  );
}

/**
 * The picture on its own, filling the screen. Tap anywhere to close.
 *
 * Deliberately offers nothing else -- no share, no save. Saving would put the
 * picture beyond its own timer with one tap; anyone who truly wants to keep
 * it can take a screenshot, which is at least a deliberate act.
 */
function FullScreenImage({ uri, visible, onClose }: { uri: string; visible: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.viewer} onPress={onClose} accessibilityLabel={t('conversation.imageClose')}>
        <Image source={{ uri }} style={styles.viewerImage} resizeMode="contain" />
        <Text style={[styles.viewerHint, { bottom: insets.bottom + 16 }]}>{t('conversation.imageTapToClose')}</Text>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  status: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    paddingHorizontal: 12,
  },
  viewer: {
    flex: 1,
    backgroundColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerImage: {
    width: '100%',
    height: '100%',
  },
  viewerHint: {
    position: 'absolute',
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },
});
