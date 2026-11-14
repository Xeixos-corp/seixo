import React from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { PasteIcon } from './icons';

type Props = {
  /** The text that was on the clipboard. Called only when there is some. */
  onPaste: (text: string) => void;
  disabled?: boolean;
};

/**
 * "Colar", beside the fields where an ID is entered.
 *
 * Pasting an ID meant holding a finger on the field and finding Paste in the
 * menu, which is one more thing for someone who already does not know what an
 * ID is. On iOS 16 and later this is Apple's own paste control: the system
 * draws it, labels it in the phone's language, and hands over the clipboard
 * only when it is pressed, so there is no "allow paste?" prompt and the app
 * never reads the clipboard on its own. Older systems get an ordinary button,
 * which reads the clipboard on the press and may show that prompt.
 */
export function PasteButton({ onPaste, disabled }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  if (Clipboard.isPasteButtonAvailable) {
    return (
      <Clipboard.ClipboardPasteButton
        onPress={(data) => {
          if (data.type === 'text' && data.text.trim()) onPaste(data.text);
        }}
        acceptedContentTypes={['plain-text']}
        displayMode="iconAndLabel"
        cornerStyle="medium"
        backgroundColor={colors.surfaceAlt}
        foregroundColor={colors.accent}
        style={[styles.native, disabled && styles.disabled]}
        pointerEvents={disabled ? 'none' : 'auto'}
        accessibilityLabel={t('peerId.pasteLabel')}
      />
    );
  }

  return (
    <Pressable
      disabled={disabled}
      onPress={async () => {
        const text = await Clipboard.getStringAsync();
        if (text.trim()) onPaste(text);
      }}
      style={({ pressed }) => [
        styles.fallback,
        { backgroundColor: pressed ? colors.border : colors.surfaceAlt },
        disabled && styles.disabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={t('peerId.pasteLabel')}
    >
      <PasteIcon size={18} color={colors.accent} />
      <Text style={{ color: colors.accent, fontWeight: '600' }}>{t('peerId.paste')}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // UIPasteControl draws nothing without an explicit size. Wide enough for
  // the icon and the word in any of the three languages ("Colar", "Paste",
  // "Pegar"), which the system writes and the app cannot change.
  native: {
    width: 96,
    height: 40,
  },
  fallback: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 10,
    paddingHorizontal: 10,
    height: 40,
  },
  disabled: {
    opacity: 0.5,
  },
});
