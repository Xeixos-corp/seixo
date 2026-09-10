import React, { useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { pickBackupFile, restoreBackup, AccountGoneError } from '../backup/recoveryBackup';
import { isValidRecoveryPhrase } from '../crypto';

type Props = NativeStackScreenProps<RootStackParamList, 'RestoreBackup'>;

/**
 * Coming back on a new phone: the file, then the phrase.
 *
 * The phrase is checked against its own checksum before anything else runs,
 * so a mistyped word is reported as a mistyped word -- at the one moment the
 * user still has the paper in front of them -- rather than surfacing later as
 * "this backup is damaged".
 */
export function RestoreBackupScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [fileUri, setFileUri] = useState<string | null>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const phraseLooksValid = isValidRecoveryPhrase(phrase);

  const handlePick = async () => {
    setErrorMessage(null);
    try {
      const picked = await pickBackupFile();
      if (picked) setFileUri(picked);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRestore = async () => {
    if (!fileUri) return;
    setBusy(true);
    setErrorMessage(null);
    try {
      await restoreBackup(phrase, fileUri);
      navigation.reset({ index: 0, routes: [{ name: 'ConversationList' }] });
    } catch (error) {
      setErrorMessage(
        error instanceof AccountGoneError
          ? t('restore.accountGone')
          : error instanceof Error
            ? error.message
            : String(error),
      );
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('restore.intro')}</Text>

        {errorMessage ? (
          <Text style={[styles.error, { color: colors.danger }]}>{errorMessage}</Text>
        ) : null}

        <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>{t('restore.step1')}</Text>
        <Pressable
          onPress={handlePick}
          style={({ pressed }) => [
            styles.secondaryButton,
            { borderColor: colors.border, backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
            {fileUri ? t('restore.fileChosen') : t('restore.chooseFile')}
          </Text>
        </Pressable>

        <Text style={[styles.stepTitle, { color: colors.textPrimary }]}>{t('restore.step2')}</Text>
        <TextInput
          value={phrase}
          onChangeText={setPhrase}
          placeholder={t('restore.phrasePlaceholder')}
          placeholderTextColor={colors.textSecondary}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          // Off on purpose: a keyboard suggesting the next word of a
          // recovery phrase is a keyboard learning it.
          spellCheck={false}
          style={[
            styles.input,
            { color: colors.textPrimary, borderColor: colors.border, backgroundColor: colors.surfaceAlt },
          ]}
        />
        {phrase.trim().length > 0 && !phraseLooksValid ? (
          <Text style={[styles.hint, { color: colors.danger }]}>{t('restore.phraseInvalid')}</Text>
        ) : null}

        <Pressable
          disabled={busy || !fileUri || !phraseLooksValid}
          onPress={handleRestore}
          style={({ pressed }) => [
            styles.primaryButton,
            {
              backgroundColor: colors.accent,
              opacity: pressed || busy || !fileUri || !phraseLooksValid ? 0.5 : 1,
            },
          ]}
        >
          {busy ? (
            <ActivityIndicator color={colors.onAccent} />
          ) : (
            <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{t('restore.button')}</Text>
          )}
        </Pressable>

        <View style={styles.footnoteBox}>
          <Text style={[styles.footnote, { color: colors.textSecondary }]}>{t('restore.footnote')}</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 32, gap: 12 },
  intro: { fontSize: 14, lineHeight: 20 },
  error: { fontSize: 14 },
  stepTitle: { fontSize: 16, fontWeight: '600', marginTop: 8 },
  secondaryButton: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  input: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 12,
    minHeight: 96,
    fontSize: 15,
    textAlignVertical: 'top',
  },
  hint: { fontSize: 13 },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  footnoteBox: { marginTop: 8 },
  footnote: { fontSize: 12, lineHeight: 18 },
});
