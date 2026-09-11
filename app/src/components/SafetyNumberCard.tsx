import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { safetyNumber, forgetPeerIdentity } from '../crypto';
import { fetchPeerIdentityKey } from '../transport/identities';

const REMOTE_DEVICE_ID = 1;

/**
 * Shows the safety number for a conversation and, when the peer's key has
 * changed, offers the way back.
 *
 * The two halves belong together on purpose. Offering "trust this new key"
 * without a way to check it would be a button that undoes the protection on
 * request -- which is worse than no button, because it looks like a decision
 * while being a reflex. Here the number is on screen first, and the wording
 * says what has to happen before pressing anything.
 */
export function SafetyNumberCard({
  peerUserId,
  showResetOption,
  onReset,
}: {
  peerUserId: string;
  /** Only when the conversation is actually blocked by a changed key. */
  showResetOption: boolean;
  onReset: () => void;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [number, setNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchPeerIdentityKey(peerUserId)
      .then((key) => {
        if (!cancelled) setNumber(safetyNumber(peerUserId, key));
      })
      .catch((cause) => {
        // Surfaced rather than swallowed: a safety number that silently fails
        // to load would leave someone believing they had verified something.
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [peerUserId]);

  const handleCopyId = async () => {
    await Clipboard.setStringAsync(peerUserId);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleReset = () => {
    try {
      forgetPeerIdentity(peerUserId, REMOTE_DEVICE_ID);
      onReset();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {t('safetyNumber.title')}
      </Text>
      <Text style={[styles.explanation, { color: colors.textSecondary }]}>
        {t('safetyNumber.explanation')}
      </Text>

      {/* The contact's full id. It used to sit under their name in the
          conversation list and was removed there in 1.9.0, which left no
          ordinary way to see it for a contact you had named. Here it sits
          with the safety number, because checking who someone is means
          comparing both. */}
      <View style={[styles.idBox, { backgroundColor: colors.surfaceAlt }]}>
        <Text style={[styles.idLabel, { color: colors.textSecondary }]}>{t('safetyNumber.idLabel')}</Text>
        <Text style={[styles.idValue, { color: colors.textPrimary }]} selectable>
          {peerUserId}
        </Text>
        <Pressable onPress={handleCopyId} hitSlop={8}>
          <Text style={[styles.idCopy, { color: colors.accent }]}>
            {copied ? t('safetyNumber.idCopied') : t('safetyNumber.copyId')}
          </Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={[styles.explanation, { color: colors.danger }]}>{error}</Text>
      ) : number ? (
        <Text style={[styles.number, { color: colors.textPrimary }]} selectable>
          {number}
        </Text>
      ) : (
        <ActivityIndicator color={colors.accent} style={styles.spinner} />
      )}

      {showResetOption ? (
        <>
          <Text style={[styles.explanation, { color: colors.danger }]}>
            {t('safetyNumber.resetWarning')}
          </Text>
          <Pressable
            onPress={handleReset}
            style={[styles.resetButton, { borderColor: colors.danger }]}
          >
            <Text style={{ color: colors.danger, fontWeight: '600' }}>
              {t('safetyNumber.resetButton')}
            </Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  explanation: {
    fontSize: 13,
    lineHeight: 18,
  },
  number: {
    fontSize: 17,
    // Monospaced digits so the groups line up between two phones held side by
    // side, which is how these are actually compared.
    fontVariant: ['tabular-nums'],
    letterSpacing: 1,
    lineHeight: 26,
    textAlign: 'center',
    paddingVertical: 6,
  },
  spinner: {
    paddingVertical: 12,
  },
  idBox: {
    borderRadius: 10,
    padding: 12,
    gap: 4,
  },
  idLabel: {
    fontSize: 12,
  },
  idValue: {
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  idCopy: {
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
  resetButton: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 11,
    alignItems: 'center',
    marginTop: 4,
  },
});
