import React, { useEffect, useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { SUPPORT_CONTACT_EMAIL, PRIVACY_POLICY_URL } from '../config/support';
import { deleteAccountAndAllLocalData } from '../identity/deleteAccount';
import { MyIdCard } from '../components/MyIdCard';
import { useAppLockStore } from '../store/appLockStore';
import { isAppLockAvailable } from '../security/appLock';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const appLockEnabled = useAppLockStore((state) => state.enabled);
  const setAppLockEnabled = useAppLockStore((state) => state.setEnabled);
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
