import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { fetchServerFootprint, type ServerFootprint } from '../transport/serverFootprint';
import { registerIdentity } from '../identity/registerIdentity';
import { NOTIFICATION_SOUNDS } from '../notifications/sounds';

/**
 * Everything the server holds about this account, read live and shown as it is.
 *
 * The privacy policy is a claim. This is the same claim with the evidence
 * attached, and it is the one thing in this app that a competitor with a
 * business model cannot copy: a screen like this on an app that collects for
 * a living would read as a confession.
 *
 * Three rules it has to keep to be worth having:
 *
 * Nothing is cached. A stale number would be a comfortable lie, and the whole
 * point is that the person can check. When the network fails it says so and
 * offers to try again, rather than showing the last thing it knew.
 *
 * Nothing is summarised on the server. Every figure here is counted from rows
 * the account is allowed to read, through the same row-level security as any
 * other query -- see transport/serverFootprint.ts.
 *
 * It says what it cannot see. The database is not the whole picture: the
 * hosting layer keeps a request log for 24 hours that this app cannot read,
 * write or delete. A screen that claimed to show everything and stopped at
 * the database would be the most misleading thing in the app.
 */
export function ServerFootprintScreen() {
  const { colors } = useAppTheme();
  const { t, i18n } = useTranslation();
  const [footprint, setFootprint] = useState<ServerFootprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { userId } = await registerIdentity();
      setFootprint(await fetchServerFootprint(userId));
    } catch (cause) {
      console.error('[ServerFootprint] failed to read', cause);
      setFootprint(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const day = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long' }) : '—';

  /** "3 h", "12 min" — how long until the earliest message expires. */
  const untilExpiry = (iso: string | null) => {
    if (!iso) return null;
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (minutes <= 0) return t('serverFootprint.expiringNow');
    if (minutes < 60) return t('serverFootprint.inMinutes', { count: minutes });
    return t('serverFootprint.inHours', { count: Math.round(minutes / 60) });
  };

  const soundLabel = (file: string | null) =>
    t(`settings.sounds.${NOTIFICATION_SOUNDS.find((s) => s.file === file)?.labelKey ?? 'default'}`);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>
          {t('serverFootprint.intro')}
        </Text>

        {loading ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}

        {error && !loading ? (
          <View style={[styles.errorBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.errorText, { color: colors.danger }]}>
              {t('serverFootprint.failed')}
            </Text>
            <Text style={[styles.errorDetail, { color: colors.textSecondary }]}>{error}</Text>
            <Pressable onPress={() => void load()} hitSlop={8}>
              <Text style={{ color: colors.accent, fontWeight: '600' }}>
                {t('serverFootprint.retry')}
              </Text>
            </Pressable>
          </View>
        ) : null}

        {footprint && !loading ? (
          <>
            <SettingsGroup title={t('serverFootprint.accountSection')}>
              <SettingsRow label={t('serverFootprint.identifier')} value={footprint.userId.slice(0, 8) + '…'} />
              <SettingsRow label={t('serverFootprint.createdAt')} value={day(footprint.createdAt)} />
              <SettingsRow
                label={t('serverFootprint.lastUse')}
                hint={t('serverFootprint.lastUseHint')}
                value={day(footprint.lastActiveOn)}
              />
              <SettingsRow
                label={t('serverFootprint.keys')}
                hint={t('serverFootprint.keysHint')}
                value={`${footprint.signedPrekeys} + ${footprint.oneTimePrekeys}`}
              />
            </SettingsGroup>

            <SettingsGroup
              title={t('serverFootprint.conversationsSection')}
              footer={footprint.channels.length === 0 ? t('serverFootprint.noConversations') : undefined}
            >
              {footprint.channels.length === 0 ? (
                <SettingsRow label={t('serverFootprint.none')} />
              ) : (
                footprint.channels.map((channel) => {
                  const expiry = untilExpiry(channel.firstExpiry);
                  const parts = [
                    t('serverFootprint.members', { count: channel.members }),
                    channel.muted ? t('serverFootprint.mutedByYou') : null,
                    expiry ? t('serverFootprint.firstExpiry', { time: expiry }) : null,
                  ].filter(Boolean);
                  return (
                    <SettingsRow
                      key={channel.channelId}
                      label={`${
                        channel.kind === 'group'
                          ? t('serverFootprint.group')
                          : t('serverFootprint.direct')
                      } · ${day(channel.createdAt)}`}
                      hint={parts.join(' · ')}
                      value={t('serverFootprint.messages', { count: channel.messages })}
                    />
                  );
                })
              )}
            </SettingsGroup>

            <SettingsGroup title={t('serverFootprint.notificationsSection')}>
              {footprint.pushToken ? (
                <>
                  <SettingsRow
                    label={t('serverFootprint.notificationText')}
                    hint={`«${footprint.pushToken.body}»`}
                    value={soundLabel(footprint.pushToken.sound)}
                  />
                  <SettingsRow
                    label={t('serverFootprint.tokenUpdated')}
                    hint={t('serverFootprint.lastUseHint')}
                    value={day(footprint.pushToken.updatedAt)}
                  />
                </>
              ) : (
                <SettingsRow label={t('serverFootprint.noToken')} />
              )}
              <SettingsRow
                label={t('serverFootprint.blocked')}
                value={String(footprint.blockedPeers)}
              />
            </SettingsGroup>

            <SettingsGroup title={t('serverFootprint.absentSection')}>
              <SettingsRow label={t('serverFootprint.absentList')} />
            </SettingsGroup>

            <Text style={[styles.footnote, { color: colors.textSecondary }]}>
              {t('serverFootprint.hostingNote')}
            </Text>
          </>
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
  footnote: { fontSize: 12, lineHeight: 17, marginTop: 16, marginLeft: 4 },
});
