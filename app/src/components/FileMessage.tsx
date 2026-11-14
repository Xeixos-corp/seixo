import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { StoredFile } from '../store/messagesStore';
import { formatFileSize } from '../messaging/attachments';
import { FileIcon } from './icons';

type Props = {
  file: StoredFile;
  tint: string;
  onOpen: () => void;
  onLongPress: () => void;
};

/**
 * A file in the conversation: its name, its size and what can be done with it.
 *
 * Pressing it opens the system's share sheet, from which it can be previewed
 * or opened in another app. Until it is on this phone it says why it cannot
 * be opened yet, rather than looking pressable and doing nothing.
 */
export function FileMessage({ file, tint, onOpen, onLongPress }: Props) {
  const { t, i18n } = useTranslation();

  const status =
    file.state === 'uploading'
      ? t('conversation.fileUploading')
      : file.state === 'failed'
        ? t('conversation.fileFailed')
        : file.state === 'unavailable'
          ? t('conversation.fileUnavailable')
          : !file.fileName
            ? t('conversation.fileDownloading')
            : t('conversation.fileOpen');
  const ready = Boolean(file.fileName) && file.state !== 'uploading';
  const busy = !file.fileName && !file.state;

  return (
    <Pressable
      onPress={ready ? onOpen : undefined}
      onLongPress={onLongPress}
      delayLongPress={350}
      accessibilityRole="button"
      accessibilityLabel={`${file.name}, ${formatFileSize(file.size, i18n.language)}. ${status}`}
      style={styles.row}
    >
      <View style={[styles.icon, { borderColor: tint }]}>
        {busy ? <ActivityIndicator size="small" color={tint} /> : <FileIcon size={22} color={tint} />}
      </View>
      <View style={styles.text}>
        <Text style={[styles.name, { color: tint }]} numberOfLines={2}>
          {file.name}
        </Text>
        <Text style={[styles.detail, { color: tint }]} numberOfLines={1}>
          {formatFileSize(file.size, i18n.language)} · {status}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 200,
    maxWidth: 260,
    paddingVertical: 2,
  },
  icon: {
    width: 40,
    height: 40,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: 2,
  },
  name: {
    fontSize: 15,
    fontWeight: '600',
  },
  detail: {
    fontSize: 12,
    opacity: 0.8,
  },
});
