import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { fetchMessageServerView, type MessageServerView } from '../transport/messageServerView';
import { getCurrentUserId } from '../identity/currentUser';

type Props = NativeStackScreenProps<RootStackParamList, 'MessageServerView'>;

/** How long the hosting layer's request log keeps a request (privacy policy). */
const HOSTING_LOG_HOURS = 24;

/**
 * One message, as the server holds it -- read live, the moment this opens.
 *
 * "What the server knows" (ServerFootprintScreen) answers the question for a
 * whole account. This answers it for the thing a person actually worries
 * about: this message, the one they just sent or received. Same rules: read
 * now rather than remembered, nothing summarised on the server, and the part
 * this app cannot see -- the hosting request log -- stated rather than left
 * out, because a screen claiming to show everything and stopping at the
 * database would be the most misleading thing here.
 */
export function MessageServerViewScreen({ route }: Props) {
  const { messageId, isMine, sentAt } = route.params;
  const { colors } = useAppTheme();
  const { t, i18n } = useTranslation();
  const [view, setView] = useState<MessageServerView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await fetchMessageServerView(messageId));
    } catch (cause) {
      console.error('[MessageServerView] failed to read', cause);
      setView(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [messageId]);

  useEffect(() => {
    void load();
  }, [load]);

  const moment = (iso: string) =>
    new Date(iso).toLocaleString(i18n.language, {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  const bytes = (count: number) =>
    count < 1024 ? `${count} B` : `${(count / 1024).toLocaleString(i18n.language, { maximumFractionDigits: 1 })} KB`;

  // Until when the hosting log can tie this message to the account that sent
  // it: a day from the send. Worked out from the message's own time, which is
  // the one the log matches against.
  const logUntil = new Date(Date.parse(view?.found ? view.createdAt : sentAt) + HOSTING_LOG_HOURS * 3600 * 1000);
  const logStillHolds = logUntil.getTime() > Date.now();

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('messageServerView.intro')}</Text>

        {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}

        {error && !loading ? (
          <View style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.errorText, { color: colors.danger }]}>{t('serverFootprint.failed')}</Text>
            <Text style={[styles.errorDetail, { color: colors.textSecondary }]}>{error}</Text>
            <Pressable onPress={() => void load()} hitSlop={8}>
              <Text style={{ color: colors.accent, fontWeight: '600' }}>{t('serverFootprint.retry')}</Text>
            </Pressable>
          </View>
        ) : null}

        {view && !view.found && !loading ? (
          <SettingsGroup title={t('messageServerView.databaseSection')} footer={t('messageServerView.goneFooter')}>
            <SettingsRow label={t('messageServerView.gone')} />
          </SettingsGroup>
        ) : null}

        {view?.found && !loading ? (
          <>
            <SettingsGroup title={t('messageServerView.databaseSection')}>
              <SettingsRow
                label={t('messageServerView.content')}
                hint={`${view.sample}…`}
                value={t('messageServerView.unreadable')}
              />
              <SettingsRow
                label={t('messageServerView.size')}
                hint={t(view.group ? 'messageServerView.sizeGroupHint' : 'messageServerView.sizeHint')}
                value={bytes(view.bytes)}
              />
              <SettingsRow label={t('messageServerView.conversation')} value={`${view.channelId.slice(0, 8)}…`} />
              <SettingsRow label={t('messageServerView.createdAt')} value={moment(view.createdAt)} />
              <SettingsRow
                label={t('messageServerView.expiresAt')}
                hint={t('messageServerView.expiresAtHint')}
                value={moment(view.expiresAt)}
              />
              <SettingsRow
                label={t('messageServerView.notified')}
                value={view.silent ? t('messageServerView.no') : t('messageServerView.yes')}
              />
              {view.group ? (
                <SettingsRow
                  label={t('messageServerView.sender')}
                  hint={t('messageServerView.senderGroupHint', { count: view.group.recipientCount })}
                  value={
                    view.group.senderUserId === getCurrentUserId()
                      ? t('messageServerView.senderYou')
                      : `${view.group.senderUserId.slice(0, 8)}…`
                  }
                />
              ) : (
                <SettingsRow
                  label={t('messageServerView.sender')}
                  hint={t('messageServerView.senderDirectHint')}
                  value={t('messageServerView.notStored')}
                />
              )}
            </SettingsGroup>

            {view.file ? (
              <SettingsGroup title={t('messageServerView.fileSection')} footer={t('messageServerView.fileFooter')}>
                <SettingsRow
                  label={t('messageServerView.fileSize')}
                  hint={t('messageServerView.fileSizeHint')}
                  value={bytes(view.file.bytes)}
                />
                {view.file.lastAccessedAt ? (
                  <SettingsRow
                    label={t('messageServerView.fileDownloaded')}
                    hint={t('messageServerView.fileDownloadedHint')}
                    value={moment(view.file.lastAccessedAt)}
                  />
                ) : (
                  <SettingsRow label={t('messageServerView.fileNotDownloaded')} />
                )}
                <SettingsRow label={t('messageServerView.fileOwner')} value={t('messageServerView.notStored')} />
              </SettingsGroup>
            ) : null}
          </>
        ) : null}

        {!loading && !error ? (
          <SettingsGroup title={t('messageServerView.hostingSection')}>
            <SettingsRow
              label={
                isMine
                  ? t('messageServerView.hostingMine')
                  : t('messageServerView.hostingTheirs')
              }
              hint={
                logStillHolds
                  ? t('messageServerView.hostingUntil', { time: moment(logUntil.toISOString()) })
                  : t('messageServerView.hostingGone')
              }
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 32, paddingTop: 16 },
  intro: { fontSize: 13, lineHeight: 19 },
  spinner: { paddingVertical: 40 },
  errorBox: {
    marginTop: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 8,
  },
  errorText: { fontSize: 15 },
  errorDetail: { fontSize: 12, lineHeight: 17 },
});
