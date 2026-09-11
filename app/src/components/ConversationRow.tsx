import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { MicIcon, PeopleIcon } from './icons';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { avatarColorFor, initialsFor } from '../theme/avatarColors';
import { conversationDisplayName, type Conversation } from '../store/conversationsStore';
import type { DecryptedMessage } from '../store/messagesStore';
import { usePrivacyPreferencesStore } from '../store/privacyPreferencesStore';
import { lastVisibleMessage } from '../messaging/lastMessage';

type Props = {
  conversation: Conversation;
  messages: DecryptedMessage[] | undefined;
  unread: number;
  onPress: () => void;
  onLongPress: () => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function formatDuration(ms: number | undefined): string {
  const total = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "18:42" today, "Yesterday", a weekday within the week, a date beyond it. */
function formatWhen(iso: string, language: string, yesterday: string): string {
  const date = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const time = date.getTime();
  if (time >= startOfToday) {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }
  if (time >= startOfToday - DAY_MS) return yesterday;
  if (time >= startOfToday - 6 * DAY_MS) {
    const weekday = date.toLocaleDateString(language, { weekday: 'short' }).replace('.', '');
    return weekday.charAt(0).toUpperCase() + weekday.slice(1);
  }
  return date.toLocaleDateString(language, { day: '2-digit', month: '2-digit' });
}

/**
 * One conversation in the list: who it is, what was said last, and when.
 *
 * Built so each friend is recognisable before anything is read -- a colour
 * and an initial per contact, a group icon for groups -- which is what the
 * list lacked when every row was a line of text in the same style.
 */
export function ConversationRow({ conversation, messages, unread, onPress, onLongPress }: Props) {
  const { colors, colorScheme } = useAppTheme();
  const { t, i18n } = useTranslation();
  const showPreviews = usePrivacyPreferencesStore((state) => state.showMessagePreviews);

  const name = conversationDisplayName(conversation, t('conversationList.unnamedGroup'));
  const hasName = Boolean(conversation.nickname?.trim()) || Boolean(conversation.isGroup);
  const avatar = avatarColorFor(
    conversation.isGroup ? conversation.channelId : conversation.peerUserId,
    colorScheme === 'dark',
  );
  const last = lastVisibleMessage(messages);
  const isUnread = unread > 0;

  const renderPreview = () => {
    if (!showPreviews) return null;
    if (!last) {
      return (
        <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
          {t('conversationList.noMessages')}
        </Text>
      );
    }
    const previewColor = isUnread ? colors.textPrimary : colors.textSecondary;
    const isVoice = Boolean(last.audioBase64 || last.audioDurationMs);
    const body = isVoice
      ? t('conversationList.voicePreview', { duration: formatDuration(last.audioDurationMs) })
      : last.plaintext.replace(/\s+/g, ' ').trim();
    const text = last.isMine ? t('conversationList.youPrefix', { text: body }) : body;
    return (
      <View style={styles.previewLine}>
        {isVoice ? <MicIcon size={14} color={previewColor} /> : null}
        <Text style={[styles.preview, styles.previewText, { color: previewColor }]} numberOfLines={1}>
          {text}
        </Text>
      </View>
    );
  };

  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        { borderColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
      ]}
    >
      <View style={[styles.avatar, { backgroundColor: avatar.background }]}>
        {conversation.isGroup ? (
          <PeopleIcon size={22} color={avatar.foreground} />
        ) : (
          <Text style={[styles.initials, { color: avatar.foreground }]}>{initialsFor(name, hasName)}</Text>
        )}
      </View>

      <View style={styles.body}>
        <View style={styles.topLine}>
          <Text
            style={[styles.name, { color: colors.textPrimary }, isUnread ? styles.nameUnread : null]}
            numberOfLines={1}
          >
            {name}
          </Text>
          {last ? (
            <Text style={[styles.when, { color: isUnread ? colors.accent : colors.textSecondary }]}>
              {formatWhen(last.createdAt, i18n.language, t('conversationList.yesterday'))}
            </Text>
          ) : null}
        </View>
        <View style={styles.bottomLine}>
          <View style={styles.previewSlot}>{renderPreview()}</View>
          {isUnread ? (
            <View
              style={[styles.badge, { backgroundColor: colors.accent }]}
              accessibilityLabel={t('conversationList.unreadBadgeLabel', { count: unread })}
            >
              <Text style={[styles.badgeText, { color: colors.onAccent }]}>{unread > 99 ? '99+' : unread}</Text>
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
  initials: { fontSize: 16, fontWeight: '600' },
  body: { flex: 1, minWidth: 0 },
  topLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flex: 1, fontSize: 16 },
  nameUnread: { fontWeight: '700' },
  when: { fontSize: 12 },
  bottomLine: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 2 },
  previewSlot: { flex: 1, minWidth: 0 },
  previewLine: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  preview: { fontSize: 14 },
  previewText: { flexShrink: 1 },
  badge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
});
