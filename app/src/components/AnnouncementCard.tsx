import React, { useCallback, useEffect, useState } from 'react';
import { AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { dismissAnnouncement, fetchCurrentAnnouncement, type Announcement } from '../transport/announcements';

/**
 * The newest notice, as a card at the top of the conversation list, until
 * this phone dismisses it.
 *
 * Asked for when the list opens and whenever the app comes back to the
 * foreground, so a notice published today reaches someone who keeps the app
 * open in the background. Shows nothing while loading and nothing on failure:
 * there is no state in which the card is half there.
 */
export function AnnouncementCard() {
  const { colors } = useAppTheme();
  const { t, i18n } = useTranslation();
  const [notice, setNotice] = useState<Announcement | null>(null);

  const load = useCallback(async () => {
    const version = Constants.expoConfig?.version ?? '0.0.0';
    setNotice(await fetchCurrentAnnouncement(i18n.language, version));
  }, [i18n.language]);

  useEffect(() => {
    void load();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load();
    });
    return () => subscription.remove();
  }, [load]);

  if (!notice) return null;

  const dismiss = () => {
    setNotice(null);
    void dismissAnnouncement(notice.id);
  };

  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <View style={styles.headerRow}>
        <View style={[styles.tag, { backgroundColor: colors.surfaceAlt }]}>
          <Text style={[styles.tagText, { color: colors.accent }]}>{t('announcement.tag')}</Text>
        </View>
        <Pressable
          onPress={dismiss}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={t('announcement.dismiss')}
        >
          <Text style={{ color: colors.textSecondary, fontSize: 20, lineHeight: 22 }}>×</Text>
        </Pressable>
      </View>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{notice.title}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{notice.body}</Text>
      {notice.actionUrl && notice.actionLabel ? (
        <Pressable
          onPress={() => void Linking.openURL(notice.actionUrl as string)}
          style={({ pressed }) => [
            styles.action,
            { backgroundColor: pressed ? colors.accentPressed : colors.accent },
          ]}
          accessibilityRole="link"
        >
          <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{notice.actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    padding: 12,
    marginBottom: 12,
    gap: 6,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  tag: {
    borderRadius: 6,
    paddingHorizontal: 7,
    paddingVertical: 2,
  },
  tagText: {
    fontSize: 11,
    fontWeight: '600',
  },
  title: {
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    fontSize: 14,
    lineHeight: 20,
  },
  action: {
    alignSelf: 'flex-start',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    marginTop: 4,
  },
});
