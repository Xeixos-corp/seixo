import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { cancelInvite, inviteLink, listMyInvites, type MyInvite } from '../transport/invites';

/**
 * The invites this account made: open, used or expired.
 *
 * It says nothing about who used one, because nobody knows: the server keeps
 * only that an invite was used, and the conversation it started is in the
 * list like any other. Read from the server each time, as the footprint
 * screen is; the only thing kept on the phone is each open invite's code, so
 * it can be shared again.
 */
export function InvitesScreen() {
  const { colors } = useAppTheme();
  const { t, i18n } = useTranslation();
  const [invites, setInvites] = useState<MyInvite[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      setInvites(await listMyInvites());
    } catch (error) {
      console.warn('[Invites] could not load', error);
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(i18n.language, { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });

  const status = (invite: MyInvite): { label: string; tone: 'open' | 'used' | 'expired' } => {
    if (invite.usedAt) return { label: t('invite.status.used'), tone: 'used' };
    if (Date.parse(invite.expiresAt) <= Date.now()) return { label: t('invite.status.expired'), tone: 'expired' };
    return { label: t('invite.status.open'), tone: 'open' };
  };

  const cancel = (invite: MyInvite) => {
    Alert.alert(t('invite.cancelTitle'), t('invite.cancelBody'), [
      { text: t('invite.cancelKeep'), style: 'cancel' },
      {
        text: t('invite.cancelConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await cancelInvite(invite.id);
            await load();
          } catch (error) {
            console.warn('[Invites] could not cancel', error);
            Alert.alert(t('invite.error.cancelFailed'));
          }
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('invite.listIntro')}</Text>

        {failed ? (
          <Pressable onPress={() => void load()} style={styles.retry}>
            <Text style={{ color: colors.accent }}>{t('invite.error.loadFailed')}</Text>
          </Pressable>
        ) : invites === null ? (
          <ActivityIndicator color={colors.accent} style={styles.spinner} />
        ) : invites.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('invite.listEmpty')}</Text>
        ) : (
          invites.map((invite) => {
            const s = status(invite);
            const open = s.tone === 'open';
            return (
              <View key={invite.id} style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.cardTop}>
                  <Text style={{ color: colors.textPrimary, fontSize: 14 }}>{t('invite.createdOn', { date: day(invite.createdAt) })}</Text>
                  <Text
                    style={[
                      styles.pill,
                      {
                        color: s.tone === 'used' ? colors.success : s.tone === 'open' ? colors.accent : colors.textSecondary,
                        borderColor: colors.border,
                      },
                    ]}
                  >
                    {s.label}
                  </Text>
                </View>
                {open ? (
                  <Text style={{ color: colors.textSecondary, fontSize: 13 }}>{t('invite.expiresOn', { date: day(invite.expiresAt) })}</Text>
                ) : null}
                {open ? (
                  <View style={styles.actions}>
                    {invite.code ? (
                      <Pressable
                        onPress={() => void Share.share({ message: t('invite.shareMessage', { link: inviteLink(invite.code as string) }) })}
                        hitSlop={6}
                      >
                        <Text style={{ color: colors.accent, fontWeight: '600' }}>{t('invite.shareAgain')}</Text>
                      </Pressable>
                    ) : null}
                    <Pressable onPress={() => cancel(invite)} hitSlop={6}>
                      <Text style={{ color: colors.danger, fontWeight: '600' }}>{t('invite.cancel')}</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20, gap: 10 },
  intro: { fontSize: 13, lineHeight: 19, marginBottom: 6 },
  spinner: { paddingVertical: 30 },
  empty: { fontSize: 15, textAlign: 'center', paddingVertical: 30 },
  retry: { paddingVertical: 20, alignItems: 'center' },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, gap: 6 },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  pill: { fontSize: 12, fontWeight: '600', borderWidth: StyleSheet.hairlineWidth, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2, overflow: 'hidden' },
  actions: { flexDirection: 'row', gap: 20, marginTop: 4 },
});
