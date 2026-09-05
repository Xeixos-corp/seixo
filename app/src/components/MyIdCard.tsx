import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Share, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import QRCode from 'react-native-qrcode-svg';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { registerIdentity } from '../identity/registerIdentity';

/**
 * Shows the local user's own user_id — as scannable QR (for in-person
 * exchange, never touches the server) and as copyable/shareable text (for
 * sending over any channel the two people already trust). Used in both
 * ConversationListScreen's empty state (the moment a new user most needs
 * this) and SettingsScreen (for later reference). Without this, there was
 * previously no way for anyone to learn their own id to give to a friend —
 * see docs/threat-model.md for that gap and why this closes it.
 */
export function MyIdCard() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // This card used to render null whenever userId wasn't set -- which covers
  // both "still loading" and "registration failed", with the failure
  // swallowed by an empty catch. In Settings that meant the whole card
  // (QR, id, share) silently wasn't there, with nothing on screen to say
  // why. Both states are now visible, and the error is logged.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    registerIdentity()
      .then(({ userId: id }) => {
        if (!cancelled) setUserId(id);
      })
      .catch((error) => {
        console.error('[MyIdCard] could not load identity', error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const handleCopy = async () => {
    if (!userId) return;
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Copying only helps if the other person is already somewhere you can
  // paste into. The system share sheet reaches WhatsApp, Messages, email and
  // everything else in one step, which is how this id will realistically be
  // handed over when the two people aren't in the same room to scan the QR.
  const handleShare = async () => {
    if (!userId) return;
    try {
      await Share.share({ message: t('myId.shareMessage', { id: userId }) });
    } catch (error) {
      console.error('[MyIdCard] share failed', error);
    }
  };

  if (failed) {
    return (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.label, { color: colors.danger }]}>{t('myId.loadFailed')}</Text>
        <Pressable onPress={() => setAttempt((n) => n + 1)} hitSlop={8}>
          <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>
            {t('myId.retry')}
          </Text>
        </Pressable>
      </View>
    );
  }

  if (!userId) {
    return (
      <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{t('myId.label')}</Text>
      <View style={styles.qrWrapper}>
        <QRCode value={userId} size={160} backgroundColor={colors.surface} color={colors.textPrimary} />
      </View>
      <Pressable onPress={handleCopy} style={styles.idRow} hitSlop={8}>
        <Text style={[styles.idText, { color: colors.textPrimary }]} numberOfLines={1} selectable>
          {userId}
        </Text>
        <Text style={{ color: colors.accent, fontSize: 13, fontWeight: '600' }}>
          {copied ? t('myId.copied') : t('myId.copy')}
        </Text>
      </Pressable>
      <Pressable onPress={handleShare} hitSlop={8}>
        <Text style={{ color: colors.accent, fontSize: 14, fontWeight: '600' }}>
          {t('myId.share')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
    gap: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  qrWrapper: {
    padding: 8,
  },
  idRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    justifyContent: 'center',
  },
  idText: {
    fontSize: 12,
    flexShrink: 1,
  },
});
