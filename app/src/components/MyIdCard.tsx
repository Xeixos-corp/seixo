import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
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

  useEffect(() => {
    let cancelled = false;
    registerIdentity()
      .then(({ userId: id }) => {
        if (!cancelled) setUserId(id);
      })
      .catch(() => {
        // Registration failure is already surfaced elsewhere (Onboarding);
        // this card just stays empty rather than duplicating that error UI.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCopy = async () => {
    if (!userId) return;
    await Clipboard.setStringAsync(userId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!userId) return null;

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
