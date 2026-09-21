import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { CODE_LENGTH } from '../security/lockCode';

type Props = {
  title: string;
  /** Second line: what this code is for, or what went wrong. */
  message?: string;
  /** Shows `message` as an error. */
  error?: boolean;
  /** No digits accepted, e.g. while waiting after too many wrong codes. */
  disabled?: boolean;
  /** Called with the full code. The dots clear once it settles, whatever it returned. */
  onComplete: (code: string) => Promise<void> | void;
};

/**
 * Six dots and a keypad, drawn by the app rather than the system keyboard.
 *
 * Its own keypad because the system keyboard remembers, predicts and, with
 * some third-party keyboards installed, sends what is typed elsewhere. A code
 * that guards a panic wipe should pass through none of that.
 */
export function CodePad({ title, message, error, disabled, onComplete }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState(false);

  // A new prompt (a different title) starts empty.
  useEffect(() => setDigits(''), [title]);

  const press = useCallback(
    (digit: string) => {
      if (busy || disabled || digits.length >= CODE_LENGTH) return;
      const next = digits + digit;
      setDigits(next);
      // Outside the state updater on purpose: React may run an updater twice,
      // and this must never check -- or wipe -- twice.
      if (next.length === CODE_LENGTH) {
        setBusy(true);
        Promise.resolve(onComplete(next)).finally(() => {
          setBusy(false);
          setDigits('');
        });
      }
    },
    [busy, disabled, digits, onComplete],
  );

  const erase = useCallback(() => {
    if (busy || disabled) return;
    setDigits((current) => current.slice(0, -1));
  }, [busy, disabled]);

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'erase'];

  return (
    <View style={styles.container}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
      <Text
        style={[styles.message, { color: error ? colors.danger : colors.textSecondary }]}
        accessibilityLiveRegion="polite"
      >
        {message ?? ' '}
      </Text>

      <View style={styles.dots} accessibilityLabel={t('codePad.entered', { count: digits.length })}>
        {Array.from({ length: CODE_LENGTH }, (_, index) => (
          <View
            key={index}
            style={[
              styles.dot,
              { borderColor: colors.textSecondary },
              index < digits.length && { backgroundColor: colors.textPrimary, borderColor: colors.textPrimary },
            ]}
          />
        ))}
      </View>

      <View style={styles.grid}>
        {keys.map((key, index) =>
          key === '' ? (
            <View key={index} style={styles.key} />
          ) : (
            <Pressable
              key={index}
              onPress={() => (key === 'erase' ? erase() : press(key))}
              disabled={busy || disabled}
              accessibilityRole="button"
              accessibilityLabel={key === 'erase' ? t('codePad.erase') : key}
              style={({ pressed }) => [
                styles.key,
                key !== 'erase' && { backgroundColor: pressed ? colors.border : colors.surfaceAlt },
                (busy || disabled) && styles.keyDisabled,
              ]}
            >
              <Text style={[key === 'erase' ? styles.eraseText : styles.keyText, { color: colors.textPrimary }]}>
                {key === 'erase' ? '⌫' : key}
              </Text>
            </Pressable>
          ),
        )}
      </View>
    </View>
  );
}

const KEY_SIZE = 72;

const styles = StyleSheet.create({
  container: { alignItems: 'center', paddingHorizontal: 24 },
  title: { fontSize: 20, fontWeight: '600', textAlign: 'center' },
  message: { fontSize: 14, lineHeight: 20, textAlign: 'center', marginTop: 8, minHeight: 40 },
  dots: { flexDirection: 'row', gap: 16, marginVertical: 24 },
  dot: { width: 14, height: 14, borderRadius: 7, borderWidth: 1.5 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', width: KEY_SIZE * 3 + 24 * 2, gap: 24, rowGap: 16 },
  key: {
    width: KEY_SIZE,
    height: KEY_SIZE,
    borderRadius: KEY_SIZE / 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  keyDisabled: { opacity: 0.4 },
  keyText: { fontSize: 28, fontWeight: '400' },
  eraseText: { fontSize: 24 },
});
