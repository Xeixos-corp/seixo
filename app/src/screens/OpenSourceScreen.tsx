import React from 'react';
import { Linking, ScrollView, StyleSheet, Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { LIBSIGNAL_URL, LICENSE_URL, SOURCE_CODE_URL } from '../config/support';

/**
 * "Código aberto e licenças": what the AGPL-3.0 asks an app to show
 * (section 5d, "Appropriate Legal Notices") and where its complete source is
 * (section 6). Seixo is under that licence because it includes libsignal.
 *
 * The other components are named with their licences rather than reproduced
 * in full: the complete list and texts are in the source repository, which
 * this screen links to.
 */
const COMPONENTS: { name: string; license: string }[] = [
  { name: 'libsignal (Signal Messenger, LLC)', license: 'AGPL-3.0' },
  { name: 'React Native, Expo', license: 'MIT' },
  { name: 'Supabase client', license: 'MIT' },
  { name: 'React Navigation, i18next, Zustand', license: 'MIT' },
  { name: 'Rust crates (RustCrypto, uniffi and others)', license: 'MIT / Apache-2.0' },
];

export function OpenSourceScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.lead, { color: colors.textPrimary }]}>{t('openSource.lead')}</Text>
        <Text style={[styles.notice, { color: colors.textSecondary }]}>{t('openSource.notice')}</Text>

        <SettingsGroup title={t('openSource.sourceSection')}>
          <SettingsRow
            label={t('openSource.sourceRow')}
            hint={SOURCE_CODE_URL.replace('https://', '')}
            onPress={() => void Linking.openURL(SOURCE_CODE_URL)}
            opensScreen
          />
          <SettingsRow
            label={t('openSource.licenseRow')}
            hint="GNU Affero General Public License v3"
            onPress={() => void Linking.openURL(LICENSE_URL)}
            opensScreen
          />
        </SettingsGroup>

        <SettingsGroup title={t('openSource.cryptoSection')} footer={t('openSource.cryptoFooter')}>
          <SettingsRow
            label="libsignal"
            hint="Copyright Signal Messenger, LLC · AGPL-3.0"
            onPress={() => void Linking.openURL(LIBSIGNAL_URL)}
            opensScreen
          />
        </SettingsGroup>

        <SettingsGroup title={t('openSource.componentsSection')} footer={t('openSource.componentsFooter')}>
          {COMPONENTS.map((component) => (
            <SettingsRow key={component.name} label={component.name} value={component.license} />
          ))}
        </SettingsGroup>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, paddingBottom: 32 },
  lead: { fontSize: 16, lineHeight: 23, fontWeight: '600', marginBottom: 8 },
  notice: { fontSize: 13, lineHeight: 19, marginBottom: 8 },
});
