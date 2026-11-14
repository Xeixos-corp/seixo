import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';

type Props = {
  /** Offered only where scanning leads somewhere: starting a conversation. */
  onScanQr?: () => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * What someone sees after typing a name where an ID goes.
 *
 * It used to be the Postgres error, `invalid input syntax for type uuid`,
 * which says the app is broken rather than that Seixo works differently. The
 * text says where the other person finds their ID, and the button goes
 * straight to the other way of getting it.
 */
export function NotAnIdHelp({ onScanQr, style }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }, style]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('peerId.notAnIdTitle')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {onScanQr ? t('peerId.notAnIdBody') : t('peerId.notAnIdBodyNoQr')}
      </Text>
      {onScanQr ? (
        <Pressable
          onPress={onScanQr}
          style={({ pressed }) => [styles.button, { backgroundColor: pressed ? colors.accentPressed : colors.accent }]}
          accessibilityRole="button"
        >
          <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{t('conversationList.scanHeaderButton')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    gap: 6,
  },
  title: {
    fontSize: 15,
    fontWeight: '600',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: 4,
  },
});
