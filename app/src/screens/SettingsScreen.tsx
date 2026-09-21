import React, { useState } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import Constants from 'expo-constants';
import * as Application from 'expo-application';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { SUPPORT_CONTACT_EMAIL, PRIVACY_POLICY_URL, TERMS_URL, FAQ_URL } from '../config/support';
import { deleteAccountAndAllLocalData } from '../identity/deleteAccount';
import { MyIdCard } from '../components/MyIdCard';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { useAppLockStore } from '../store/appLockStore';
import { useThemeStore, type ThemePreference } from '../store/themeStore';
import { usePrivacyPreferencesStore } from '../store/privacyPreferencesStore';
import { useNotificationSoundStore } from '../store/notificationSoundStore';
import { NOTIFICATION_SOUNDS } from '../notifications/sounds';
import { useBlockedPeersStore } from '../store/blockedPeersStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

/**
 * What version this is, for the bottom of the screen.
 *
 * Not decoration: every support conversation opens with "which version are
 * you on", and an answer nobody has to go looking for saves a round trip on
 * every single one. The build number matters as much as the version here,
 * because TestFlight ships many builds under one version.
 */
function appVersionLabel(): string {
  const version = Constants.expoConfig?.version ?? '—';
  const build = Application.nativeBuildVersion;
  return build ? `${version} (${build})` : version;
}

export function SettingsScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [deleting, setDeleting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const themePreference = useThemeStore((state) => state.preference);
  const setThemePreference = useThemeStore((state) => state.setPreference);
  const appLockEnabled = useAppLockStore((state) => state.enabled);
  const appLockMethod = useAppLockStore((state) => state.method);
  const showMessagePreviews = usePrivacyPreferencesStore((state) => state.showMessagePreviews);
  const setShowMessagePreviews = usePrivacyPreferencesStore((state) => state.setShowMessagePreviews);
  const sound = useNotificationSoundStore((state) => state.sound);
  const blockedCount = useBlockedPeersStore((state) => state.blockedPeerIds.length);
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

  const soundLabel = t(
    `settings.sounds.${NOTIFICATION_SOUNDS.find((option) => option.file === sound)?.labelKey ?? 'default'}`,
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.idCard}>
          <MyIdCard />
        </View>

        <SettingsGroup title={t('settings.privacySection')}>
          {/* A screen of its own now that there are two kinds of lock and a
              panic code: a switch could only ever say on or off. */}
          <SettingsRow
            label={t('settings.appLockRow')}
            hint={t('settings.appLockRowHint')}
            value={
              !appLockEnabled
                ? t('lockSettings.offShort')
                : appLockMethod === 'code'
                  ? t('lockSettings.codeShort')
                  : t('lockSettings.deviceShort')
            }
            onPress={() => navigation.navigate('AppLockSettings')}
            opensScreen
          />
          <SettingsRow
            label={t('settings.showPreviewsLabel')}
            hint={t('settings.showPreviewsHint')}
            toggle={{ value: showMessagePreviews, onValueChange: setShowMessagePreviews }}
          />
          {/* Moved here from the conversation list's header, which had three
              buttons competing for the top bar -- and which made a liar of
              both the FAQ and the app's own blocking confirmation, each of
              which tells people to look in Settings. */}
          <SettingsRow
            label={t('settings.blockedPeers')}
            value={blockedCount > 0 ? String(blockedCount) : undefined}
            onPress={() => navigation.navigate('BlockedPeers')}
            opensScreen
          />
          {/* The policy says what the server keeps; this shows it. Put here
              rather than under "About" because it is not reading material --
              it is the same claim with the evidence attached. */}
          <SettingsRow
            label={t('settings.serverFootprint')}
            hint={t('settings.serverFootprintHint')}
            onPress={() => navigation.navigate('ServerFootprint')}
            opensScreen
          />
        </SettingsGroup>

        <SettingsGroup title={t('settings.appearanceSection')}>
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
        </SettingsGroup>

        <SettingsGroup title={t('settings.notificationsSection')}>
          <SettingsRow
            label={t('settings.soundRow')}
            value={soundLabel}
            onPress={() => navigation.navigate('NotificationSound')}
            opensScreen
          />
        </SettingsGroup>

        {/* The hint belongs to the backup row, not to the group: as a group
            footer it sat under "Delete account" and read as though it
            described deleting. */}
        <SettingsGroup title={t('settings.accountSection')}>
          <SettingsRow
            label={t('settings.backupButton')}
            hint={t('settings.backupHint')}
            onPress={() => navigation.navigate('Backup')}
            opensScreen
          />
          {/* Beside the backup on purpose: both decide whether this account
              goes on existing, and anyone on their way to delete should pass
              the one thing that would let them come back. */}
          <SettingsRow
            label={deleting ? t('settings.deleting') : t('settings.deleteButton')}
            onPress={confirmDelete}
            disabled={deleting}
            danger
          />
        </SettingsGroup>

        {errorMessage ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
        ) : null}

        <SettingsGroup title={t('settings.aboutSection')}>
          <SettingsRow label={t('settings.faq')} onPress={() => Linking.openURL(FAQ_URL)} opensScreen />
          {SUPPORT_CONTACT_EMAIL ? (
            <SettingsRow
              label={t('settings.contact')}
              value={SUPPORT_CONTACT_EMAIL}
              onPress={() => Linking.openURL(`mailto:${SUPPORT_CONTACT_EMAIL}`)}
            />
          ) : (
            <SettingsRow label={t('settings.supportUnset')} />
          )}
          <SettingsRow
            label={t('settings.privacyPolicy')}
            onPress={() => Linking.openURL(PRIVACY_POLICY_URL)}
            opensScreen
          />
          <SettingsRow
            label={t('settings.termsOfUse')}
            onPress={() => Linking.openURL(TERMS_URL)}
            opensScreen
          />
          <SettingsRow label={t('settings.version')} value={appVersionLabel()} />
        </SettingsGroup>
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
    paddingBottom: 32,
  },
  idCard: {
    marginTop: 20,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  themeChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  errorText: {
    fontSize: 13,
    marginTop: 10,
  },
});
