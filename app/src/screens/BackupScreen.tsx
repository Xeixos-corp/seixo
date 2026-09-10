import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import {
  createBackup,
  shareBackup,
  BackupCredentialsError,
  type CreatedBackup,
} from '../backup/recoveryBackup';

/**
 * Making a recovery backup: the phrase first, the file second.
 *
 * The two are shown in that order deliberately. The file is useless without
 * the phrase, and the phrase is the part a user is tempted to skip -- so it
 * gets the screen to itself, and the share button only appears underneath it.
 */
export function BackupScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [backup, setBackup] = useState<CreatedBackup | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleCreate = async () => {
    setBusy(true);
    setErrorMessage(null);
    try {
      setBackup(await createBackup());
    } catch (error) {
      setErrorMessage(
        error instanceof BackupCredentialsError
          ? t('backup.credentialsError')
          : error instanceof Error
            ? error.message
            : String(error),
      );
    } finally {
      setBusy(false);
    }
  };

  const handleShare = async () => {
    if (!backup) return;
    try {
      await shareBackup(backup.fileUri);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleCopyPhrase = async () => {
    if (!backup) return;
    await Clipboard.setStringAsync(backup.phrase);
    Alert.alert(t('backup.phraseCopiedTitle'), t('backup.phraseCopiedMessage'));
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('backup.intro')}</Text>

        {errorMessage ? (
          <Text style={[styles.error, { color: colors.danger }]}>{errorMessage}</Text>
        ) : null}

        {!backup ? (
          <Pressable
            disabled={busy}
            onPress={handleCreate}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.accent, opacity: pressed || busy ? 0.7 : 1 },
            ]}
          >
            {busy ? (
              <ActivityIndicator color={colors.onAccent} />
            ) : (
              <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
                {t('backup.createButton')}
              </Text>
            )}
          </Pressable>
        ) : (
          <>
            <View
              style={[
                styles.phraseCard,
                { backgroundColor: colors.surfaceAlt, borderColor: colors.border },
              ]}
            >
              <Text style={[styles.phraseTitle, { color: colors.textPrimary }]}>
                {t('backup.phraseTitle')}
              </Text>
              <View style={styles.wordGrid}>
                {backup.phrase.split(' ').map((word, index) => (
                  <View
                    key={`${index}-${word}`}
                    style={[styles.word, { backgroundColor: colors.surface, borderColor: colors.border }]}
                  >
                    <Text style={[styles.wordIndex, { color: colors.textSecondary }]}>{index + 1}</Text>
                    <Text style={[styles.wordText, { color: colors.textPrimary }]}>{word}</Text>
                  </View>
                ))}
              </View>
              <Text style={[styles.warning, { color: colors.danger }]}>{t('backup.phraseWarning')}</Text>
              <Pressable onPress={handleCopyPhrase}>
                <Text style={[styles.link, { color: colors.accent }]}>{t('backup.copyPhrase')}</Text>
              </Pressable>
            </View>

            <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>
              {t('backup.fileTitle')}
            </Text>
            <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('backup.fileHint')}</Text>
            <Pressable
              onPress={handleShare}
              style={({ pressed }) => [
                styles.primaryButton,
                { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 },
              ]}
            >
              <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
                {t('backup.shareButton')}
              </Text>
            </Pressable>
          </>
        )}

        <Text style={[styles.footnote, { color: colors.textSecondary }]}>{t('backup.footnote')}</Text>
        {/* A backup is insurance against losing the phone, not against not
            using the app -- the abandoned-account purge takes the account
            either way. Saying so here beats letting someone find out on the
            day they need it. */}
        <Text style={[styles.footnote, { color: colors.textSecondary }]}>
          {t('backup.expiryWarning')}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 16 },
  intro: { fontSize: 14, lineHeight: 20 },
  error: { fontSize: 14 },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  phraseCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  phraseTitle: { fontSize: 16, fontWeight: '600' },
  wordGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  word: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  // Tabular figures so the numbers form a straight column while the phrase is
  // being copied onto paper -- this list gets read one line at a time.
  wordIndex: { fontSize: 11, fontVariant: ['tabular-nums'] },
  wordText: { fontSize: 15, fontWeight: '500' },
  warning: { fontSize: 13, lineHeight: 18 },
  link: { fontSize: 14, fontWeight: '600' },
  stepTitle: { fontSize: 16, fontWeight: '600', marginTop: 8 },
  footnote: { fontSize: 12, lineHeight: 18, marginTop: 8 },
});
