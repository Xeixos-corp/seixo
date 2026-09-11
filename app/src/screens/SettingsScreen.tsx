import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { SUPPORT_CONTACT_EMAIL, PRIVACY_POLICY_URL, TERMS_URL } from '../config/support';
import { deleteAccountAndAllLocalData } from '../identity/deleteAccount';
import { MyIdCard } from '../components/MyIdCard';
import { useAppLockStore } from '../store/appLockStore';
import { useThemeStore, type ThemePreference } from '../store/themeStore';
import { usePrivacyPreferencesStore } from '../store/privacyPreferencesStore';
import { isAppLockAvailable } from '../security/appLock';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const themePreference = useThemeStore((state) => state.preference);
  const setThemePreference = useThemeStore((state) => state.setPreference);
  const appLockEnabled = useAppLockStore((state) => state.enabled);
  const setAppLockEnabled = useAppLockStore((state) => state.setEnabled);
  const showMessagePreviews = usePrivacyPreferencesStore((state) => state.showMessagePreviews);
  const setShowMessagePreviews = usePrivacyPreferencesStore((state) => state.setShowMessagePreviews);
  // null while the check is in flight -- the toggle stays disabled until we
  // know, rather than letting the user turn on a lock the device can't honour.
  const [lockAvailable, setLockAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    isAppLockAvailable().then((available) => {
      if (!cancelled) setLockAvailable(available);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          {t('settings.appearanceSection')}
        </Text>
        <View style={styles.themeRow}>
          {(['system', 'light', 'dark'] as ThemePreference[]).map((option) => {
            const selected = themePreference === option;
            return (
              <Pressable
                key={option}
                onPress={() => setThemePreference(option)}
                style={[
                  styles.themeChip,
                  {
                    backgroundColor: selected ? colors.accent : colors.surfaceAlt,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text style={{ color: selected ? colors.onAccent : colors.textSecondary, fontSize: 13 }}>
                  {t(`settings.theme.${option}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          {t('settings.securitySection')}
        </Text>
        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: colors.textPrimary }]}>
            {t('settings.appLockLabel')}
          </Text>
          <Switch
            value={appLockEnabled}
            onValueChange={setAppLockEnabled}
            disabled={lockAvailable !== true}
          />
        </View>
        <Text style={[styles.settingHint, { color: colors.textSecondary }]}>
          {lockAvailable === false ? t('settings.appLockUnavailable') : t('settings.appLockHint')}
        </Text>
        <View style={styles.settingRow}>
          <Text style={[styles.settingLabel, { color: colors.textPrimary }]}>
            {t('settings.showPreviewsLabel')}
          </Text>
          <Switch value={showMessagePreviews} onValueChange={setShowMessagePreviews} />
        </View>
        <Text style={[styles.settingHint, { color: colors.textSecondary }]}>
          {t('settings.showPreviewsHint')}
        </Text>
      </View>

      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          {t('settings.backupSection')}
        </Text>
        <Pressable
          onPress={() => navigation.navigate('Backup')}
          style={({ pressed }) => [
            styles.linkRow,
            { borderColor: colors.border, backgroundColor: colors.surfaceAlt, opacity: pressed ? 0.7 : 1 },
          ]}
        >
          <Text style={{ color: colors.textPrimary, fontWeight: '600' }}>
            {t('settings.backupButton')}
          </Text>
        </Pressable>
        <Text style={[styles.settingHint, { color: colors.textSecondary }]}>
          {t('settings.backupHint')}
        </Text>
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
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('settings.legalSection')}</Text>
        <Pressable onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}>
          <Text style={[styles.link, { color: colors.accent }]}>{t('settings.privacyPolicy')}</Text>
        </Pressable>
        <Pressable onPress={() => Linking.openURL(TERMS_URL)}>
          <Text style={[styles.link, { color: colors.accent }]}>{t('settings.termsOfUse')}</Text>
        </Pressable>
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
  linkRow: {
    borderRadius: 12,
    borderWidth: 1,
    paddingVertical: 14,
    alignItems: 'center',
  },
  themeRow: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  themeChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  settingLabel: {
    fontSize: 15,
    flexShrink: 1,
  },
  settingHint: {
    fontSize: 13,
    lineHeight: 18,
    marginTop: 6,
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
