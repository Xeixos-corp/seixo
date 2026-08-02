import React, { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { SUPPORT_CONTACT_EMAIL } from '../config/support';
import { deleteAccountAndAllLocalData } from '../identity/deleteAccount';
import { MyIdCard } from '../components/MyIdCard';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleDelete = async () => {
    setDeleting(true);
    setErrorMessage(null);
    try {
      await deleteAccountAndAllLocalData();
      navigation.reset({ index: 0, routes: [{ name: 'Onboarding' }] });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
      setDeleting(false);
    }
  };

  const confirmDelete = () => {
    Alert.alert(
      t('settings.deleteConfirmTitle'),
      t('settings.deleteConfirmMessage'),
      [
        { text: t('conversation.cancel'), style: 'cancel' },
        { text: t('settings.deleteButtonConfirm'), style: 'destructive', onPress: handleDelete },
      ],
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
      <View style={styles.section}>
        <MyIdCard />
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('settings.supportSection')}</Text>
        {SUPPORT_CONTACT_EMAIL ? (
          <Pressable onPress={() => Linking.openURL(`mailto:${SUPPORT_CONTACT_EMAIL}`)}>
            <Text style={[styles.link, { color: colors.accent }]}>{SUPPORT_CONTACT_EMAIL}</Text>
          </Pressable>
        ) : (
          <Text style={{ color: colors.textSecondary }}>{t('settings.supportUnset')}</Text>
        )}
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('settings.accountSection')}</Text>
        {errorMessage ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
        ) : null}
        <Pressable
          disabled={deleting}
          onPress={confirmDelete}
          style={({ pressed }) => [
            styles.dangerButton,
            { backgroundColor: colors.danger, opacity: pressed || deleting ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
            {deleting ? t('settings.deleting') : t('settings.deleteButton')}
          </Text>
        </Pressable>
      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  section: {
    marginTop: 24,
    gap: 8,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  link: {
    fontSize: 15,
  },
  errorText: {
    fontSize: 13,
  },
  dangerButton: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
});
