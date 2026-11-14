import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { fetchServerFootprint, type ServerFootprint } from '../transport/serverFootprint';
import { fetchWhatTheHostSees, type WhatTheHostSees } from '../transport/whatTheHostSees';
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
 * hosting layer keeps a request log, under its own rules, that this app cannot
 * read, write or delete. A screen that claimed to show everything and stopped
 * at the database would be the most misleading thing in the app. What that
 * log records about the request being made right now, though, the app can be
 * told, and the last section shows it on request.
 */
export function ServerFootprintScreen() {
  const { colors } = useAppTheme();
  const { t, i18n } = useTranslation();
  const [footprint, setFootprint] = useState<ServerFootprint | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Asked for only when the button is pressed, never on opening the screen:
  // it is a request of its own, logged like any other.
  const [hostView, setHostView] = useState<WhatTheHostSees | null>(null);
  const [hostLoading, setHostLoading] = useState(false);
  const [hostError, setHostError] = useState(false);

  const loadHostView = useCallback(async () => {
    setHostLoading(true);
    setHostError(false);
    try {
      setHostView(await fetchWhatTheHostSees());
    } catch (cause) {
      console.error('[ServerFootprint] failed to ask what the host sees', cause);
      setHostView(null);
      setHostError(true);
    } finally {
      setHostLoading(false);
    }
  }, []);

  /** "Portugal" where the engine can name it, otherwise the code itself. */
  const countryName = (code: string) => {
    try {
      const DisplayNames = (Intl as unknown as { DisplayNames?: new (locales: string[], options: { type: 'region' }) => { of: (code: string) => string | undefined } }).DisplayNames;
      if (DisplayNames) return new DisplayNames([i18n.language], { type: 'region' }).of(code) ?? code;
    } catch {
      // Hermes may not have it; the code is still the truth.
    }
    return code;
  };

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
              {/* A column from the first migration that this app has never
                  written to, and which is empty on every account. Shown only
                  if something is ever there -- a screen that claims to list
                  everything cannot quietly skip a field just because it is
                  usually blank. */}
              {footprint.hasDisplayNameCiphertext ? (
                <SettingsRow
                  label={t('serverFootprint.displayName')}
                  hint={t('serverFootprint.displayNameHint')}
                />
              ) : null}
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

            <SettingsGroup
              title={t('serverFootprint.imagesSection')}
              footer={t('serverFootprint.imagesFooter')}
            >
              <SettingsRow
                label={t('serverFootprint.images', { count: footprint.images.count })}
                value={footprint.images.count ? formatBytes(footprint.images.bytes, i18n.language) : undefined}
              />
              {footprint.images.count ? (
                <SettingsRow
                  label={t('serverFootprint.imagesDownloaded')}
                  hint={t('serverFootprint.imagesDownloadedHint')}
                  value={`${footprint.images.downloaded} / ${footprint.images.count}`}
                />
              ) : null}
            </SettingsGroup>

            <SettingsGroup title={t('serverFootprint.notificationsSection')}>
              {/* An array rather than a fragment: the group counts its
                  children to draw the dividers between them, and a fragment
                  arrives as one child however many rows are inside it. */}
              {footprint.pushToken
                ? [
                    <SettingsRow
                      key="text"
                      label={t('serverFootprint.notificationText')}
                      hint={`«${footprint.pushToken.body}»`}
                      value={soundLabel(footprint.pushToken.sound)}
                    />,
                    <SettingsRow
                      key="updated"
                      label={t('serverFootprint.tokenUpdated')}
                      hint={t('serverFootprint.lastUseHint')}
                      value={day(footprint.pushToken.updatedAt)}
                    />,
                  ]
                : <SettingsRow label={t('serverFootprint.noToken')} />}
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

            <View style={styles.hostGroup}>
              <SettingsGroup
                title={t('serverFootprint.hostNowSection')}
                footer={t('serverFootprint.hostNowFooter')}
              >
                {hostView
                  ? [
                      <SettingsRow key="ip" label={t('serverFootprint.hostIp')} value={hostView.ip ?? t('serverFootprint.hostUnknown')} />,
                      // Today only the address reaches the function; the
                      // place stays in the entry layer (see the comment in
                      // supabase/functions/what-the-host-sees). Shown if it
                      // ever arrives, never as an empty "unknown".
                      ...(hostView.tor || hostView.country
                        ? [
                            <SettingsRow
                              key="country"
                              label={t('serverFootprint.hostCountry')}
                              value={hostView.tor ? t('serverFootprint.hostTor') : countryName(hostView.country as string)}
                            />,
                          ]
                        : []),
                      ...(hostView.region
                        ? [<SettingsRow key="region" label={t('serverFootprint.hostRegion')} value={hostView.region} />]
                        : []),
                      ...(hostView.city
                        ? [<SettingsRow key="city" label={t('serverFootprint.hostCity')} value={hostView.city} />]
                        : []),
                      ...(hostView.postalCode
                        ? [<SettingsRow key="postal" label={t('serverFootprint.hostPostalCode')} value={hostView.postalCode} />]
                        : []),
                      <SettingsRow
                        key="again"
                        label={hostLoading ? t('serverFootprint.hostAsking') : t('serverFootprint.hostAskAgain')}
                        onPress={hostLoading ? undefined : () => void loadHostView()}
                      />,
                    ]
                  : (
                    <SettingsRow
                      label={
                        hostLoading
                          ? t('serverFootprint.hostAsking')
                          : hostError
                            ? t('serverFootprint.hostFailed')
                            : t('serverFootprint.hostAsk')
                      }
                      hint={hostError ? undefined : t('serverFootprint.hostAskHint')}
                      onPress={hostLoading ? undefined : () => void loadHostView()}
                    />
                  )}
              </SettingsGroup>
            </View>
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
  hostGroup: { marginTop: 20 },
});

/** "340 KB", "1,2 MB" -- enough precision to be honest, not enough to be noise. */
function formatBytes(bytes: number, language: string): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = (bytes / (1024 * 1024)).toLocaleString(language, { maximumFractionDigits: 1 });
  return `${megabytes} MB`;
}
