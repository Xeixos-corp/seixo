import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useMessagesStore, type DecryptedMessage } from '../store/messagesStore';
import {
  useConversationsStore,
  conversationDisplayName,
  DEFAULT_TTL_SECONDS,
} from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { fetchMessages, sendMessage, subscribeToChannelMessages, type FetchedMessage } from '../transport/messages';
import { blockPeer } from '../transport/blocking';
import { registerIdentity } from '../identity/registerIdentity';
import { encryptMessage, decryptMessage, isUntrustedIdentityError } from '../crypto';
import { SUPPORT_CONTACT_EMAIL } from '../config/support';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

const REMOTE_DEVICE_ID = 1; // single device per identity for now

// Stable reference for "this channel has no messages yet". Returning a fresh
// `[]` from the selector below instead would hand React a different snapshot
// on every render: useSyncExternalStore (which zustand v5 is built on)
// treats that as the store having changed, re-renders, gets another new
// array, and throws "The result of getSnapshot should be cached to avoid an
// infinite loop". That error escapes to the root and unmounts the entire
// app -- a completely white screen, no header, no error text.
//
// It only bites on channels with no decrypted messages, i.e. exactly when
// opening a conversation you just started, which is why it survived until
// someone actually tried to chat.
const NO_MESSAGES: DecryptedMessage[] = [];

const TTL_OPTIONS: Array<{ key: string; seconds: number }> = [
  { key: '30s', seconds: 30 },
  { key: '5min', seconds: 5 * 60 },
  { key: '1hour', seconds: 60 * 60 },
  { key: '1day', seconds: 24 * 60 * 60 },
  { key: '1week', seconds: 7 * 24 * 60 * 60 },
];

/**
 * How long until this message disappears, in coarse units. Deliberately
 * approximate: the countdown is reassurance that the timer is real, not a
 * precision instrument — the actual removal is driven by scheduleExpiry and
 * the server-side purge, not by this label.
 */
function formatTimeLeft(expiresAt: string, now: number, t: TFunction): string {
  const msLeft = new Date(expiresAt).getTime() - now;
  const seconds = Math.max(0, Math.round(msLeft / 1000));

  if (seconds < 60) return t('conversation.expiresInSeconds', { count: seconds });
  if (seconds < 60 * 60) return t('conversation.expiresInMinutes', { count: Math.round(seconds / 60) });
  if (seconds < 24 * 60 * 60) return t('conversation.expiresInHours', { count: Math.round(seconds / 3600) });
  return t('conversation.expiresInDays', { count: Math.round(seconds / 86400) });
}

export function ConversationScreen({ route, navigation }: Props) {
  const { channelId, peerUserId } = route.params;
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const messages = useMessagesStore((state) => state.messagesByChannel[channelId] ?? NO_MESSAGES);
  const addMessage = useMessagesStore((state) => state.addMessage);
  const removeMessage = useMessagesStore((state) => state.removeMessage);
  const ttlSeconds = useConversationsStore(
    (state) => state.conversations.find((c) => c.channelId === channelId)?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  );
  const setConversationTtl = useConversationsStore((state) => state.setConversationTtl);
  // Returns a string, so this selector compares by value and stays stable.
  const conversationName = useConversationsStore((state) => {
    const conversation = state.conversations.find((c) => c.channelId === channelId);
    return conversation ? conversationDisplayName(conversation) : `${peerUserId.slice(0, 8)}…`;
  });
  const isBlocked = useBlockedPeersStore((state) => state.isBlocked);
  const addBlockedPeer = useBlockedPeersStore((state) => state.addBlockedPeer);
  const removeConversation = useConversationsStore((state) => state.removeConversation);

  const handleBlock = useCallback(() => {
    Alert.alert(
      t('conversation.blockConfirmTitle'),
      t('conversation.blockConfirmMessage', { peerId: peerUserId }),
      [
        { text: t('conversation.cancel'), style: 'cancel' },
        {
          text: t('conversation.confirmBlock'),
          style: 'destructive',
          onPress: async () => {
            try {
              const { userId } = await registerIdentity();
              await blockPeer(userId, peerUserId);
              addBlockedPeer(peerUserId);
              removeConversation(channelId);
              navigation.navigate('ConversationList');
            } catch (error) {
              console.error('[ConversationScreen] failed to block peer', error);
            }
          },
        },
      ],
    );
  }, [peerUserId, channelId, addBlockedPeer, removeConversation, navigation, t]);

  const handleReport = useCallback(() => {
    if (!SUPPORT_CONTACT_EMAIL) return;
    const subject = encodeURIComponent(t('conversation.reportEmailSubject'));
    const body = encodeURIComponent(t('conversation.reportEmailBody', { peerId: peerUserId }));
    Linking.openURL(`mailto:${SUPPORT_CONTACT_EMAIL}?subject=${subject}&body=${body}`);
  }, [peerUserId, t]);

  useEffect(() => {
    navigation.setOptions({
      title: conversationName,
      headerRight: () => (
        <View style={styles.headerButtons}>
          {SUPPORT_CONTACT_EMAIL ? (
            <Pressable onPress={handleReport} hitSlop={8}>
              <Text style={{ color: colors.accent, fontSize: 13 }}>{t('conversation.reportButton')}</Text>
            </Pressable>
          ) : null}
          <Pressable onPress={handleBlock} hitSlop={8}>
            <Text style={{ color: colors.danger, fontSize: 13 }}>{t('conversation.blockButton')}</Text>
          </Pressable>
        </View>
      ),
    });
  }, [navigation, colors.accent, colors.danger, handleBlock, handleReport, t, conversationName]);

  // Drives the per-message countdown labels. Coarse on purpose (10s): the
  // label only needs to be roughly right, and the actual disappearance is
  // handled by scheduleExpiry, not by this.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when establishSession/encrypt/decrypt fails because the peer's
  // identity key changed since the last session (see
  // crypto/index.ts::isUntrustedIdentityError) — the equivalent of Signal's
  // "safety number changed" warning. Distinct from loadError/console.error
  // below: without this, a changed identity used to fail completely
  // silently (no UI signal at all that something needs attention).
  const [securityWarning, setSecurityWarning] = useState<string | null>(null);

  // Local-side disappearing-message timers, keyed by message id, so we can
  // cancel them on unmount instead of leaking setTimeouts. This runs
  // alongside — not instead of — the server-side pg_cron purge; it's what
  // makes an expired message disappear from an already-open conversation
  // screen without waiting for a re-fetch.
  const expiryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleExpiry = useCallback(
    (id: string, expiresAt: string) => {
      const delayMs = new Date(expiresAt).getTime() - Date.now();
      if (delayMs <= 0) {
        removeMessage(channelId, id);
        return;
      }
      const timer = setTimeout(() => {
        removeMessage(channelId, id);
        expiryTimers.current.delete(id);
      }, delayMs);
      expiryTimers.current.set(id, timer);
    },
    [channelId, removeMessage],
  );

  useEffect(() => {
    const timers = expiryTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, [channelId]);

  // Messages restored from disk (messagesStore is persisted) never went
  // through decryptAndStore/handleSend on this launch, so nothing scheduled
  // their expiry. Without this, reopening the app would leave a message with
  // a 30-second timer sitting on screen indefinitely — the disappearing
  // timer would silently only work within a single session.
  //
  // Safe to run on every messages change: scheduleExpiry is keyed by id and
  // guarded here against double-scheduling, and it removes anything already
  // past its expiry immediately.
  useEffect(() => {
    messages.forEach((message) => {
      if (!expiryTimers.current.has(message.id)) {
        scheduleExpiry(message.id, message.expiresAt);
      }
    });
  }, [messages, scheduleExpiry]);

  const decryptAndStore = useCallback(
    (fetched: FetchedMessage) => {
      // Defense in depth: normally unreachable, since blocking navigates
      // away from this screen immediately (see handleBlock above), but a
      // realtime event could theoretically arrive in the gap before that
      // navigation completes.
      if (isBlocked(peerUserId)) return;

      // Own just-sent messages are recorded locally at send time (we already
      // have the plaintext — see handleSend). Decrypting them again here
      // would desync the ratchet: a party can never decrypt its own sent
      // ciphertext, sending and receiving use separate chain keys. Skipping
      // anything already known also protects against fetchMessages() and a
      // realtime INSERT both delivering the same row.
      const alreadyKnown = useMessagesStore
        .getState()
        .messagesByChannel[channelId]?.some((m) => m.id === fetched.id);
      if (alreadyKnown) return;

      // Already expired (e.g. fetched in the window before pg_cron's next
      // purge pass) — not worth spending the one-time Double Ratchet
      // message key to decrypt something we're about to discard anyway.
      if (new Date(fetched.expiresAt).getTime() <= Date.now()) return;

      try {
        const plaintext = decryptMessage(peerUserId, REMOTE_DEVICE_ID, fetched.envelope);
        addMessage(channelId, {
          id: fetched.id,
          createdAt: fetched.createdAt,
          expiresAt: fetched.expiresAt,
          plaintext,
        });
        scheduleExpiry(fetched.id, fetched.expiresAt);
      } catch (error) {
        if (isUntrustedIdentityError(error)) {
          setSecurityWarning(t('conversation.securityWarningDecrypt', { peerId: peerUserId }));
        }
        console.error('[ConversationScreen] failed to decrypt message', fetched.id, error);
      }
    },
    [channelId, peerUserId, addMessage, scheduleExpiry, isBlocked, t],
  );

  useEffect(() => {
    let cancelled = false;

    fetchMessages(channelId)
      .then((fetched) => {
        if (cancelled) return;
        fetched.forEach(decryptAndStore);
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });

    const unsubscribe = subscribeToChannelMessages(channelId, decryptAndStore);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [channelId, decryptAndStore]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      const envelope = encryptMessage(peerUserId, REMOTE_DEVICE_ID, text);
      const { id, createdAt, expiresAt } = await sendMessage(channelId, envelope, ttlSeconds);
      addMessage(channelId, { id, createdAt, expiresAt, plaintext: text });
      scheduleExpiry(id, expiresAt);
      setInputText('');
    } catch (error) {
      if (isUntrustedIdentityError(error)) {
        setSecurityWarning(t('conversation.securityWarningSend', { peerId: peerUserId }));
      }
      console.error('[ConversationScreen] failed to send message', error);
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        {loadError ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{loadError}</Text>
        ) : null}

        {securityWarning ? (
          <View style={[styles.securityWarning, { backgroundColor: colors.surfaceAlt, borderColor: colors.danger }]}>
            <Text style={[styles.securityWarningText, { color: colors.danger }]}>{securityWarning}</Text>
          </View>
        ) : null}

        <Text style={[styles.ttlLabel, { color: colors.textSecondary }]}>
          {t('conversation.ttlLabel')}
        </Text>

        <View style={styles.ttlRow}>
          {TTL_OPTIONS.map((option) => {
            const selected = option.seconds === ttlSeconds;
            return (
              <Pressable
                key={option.seconds}
                onPress={() => setConversationTtl(channelId, option.seconds)}
                style={[
                  styles.ttlChip,
                  {
                    backgroundColor: selected ? colors.accent : colors.surfaceAlt,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text style={{ color: selected ? colors.onAccent : colors.textSecondary, fontSize: 12 }}>
                  {t(`conversation.ttl.${option.key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <FlatList
          data={messages}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messagesContent}
          renderItem={({ item }) => (
            <View style={[styles.messageBubble, { backgroundColor: colors.surfaceAlt }]}>
              <Text style={{ color: colors.textPrimary }}>{item.plaintext}</Text>
              <Text style={[styles.messageExpiry, { color: colors.textSecondary }]}>
                {formatTimeLeft(item.expiresAt, now, t)}
              </Text>
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.messages}>
              <Text style={[styles.placeholder, { color: colors.textSecondary }]}>
                {t('conversation.emptyState')}
              </Text>
            </View>
          }
        />

        <View style={[styles.inputBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { color: colors.textPrimary }]}
            placeholder={t('conversation.inputPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            value={inputText}
            onChangeText={setInputText}
            editable={!sending}
            multiline
          />
          <Pressable
            disabled={sending || !inputText.trim()}
            onPress={handleSend}
            style={({ pressed }) => [
              styles.sendButton,
              { backgroundColor: pressed ? colors.accentPressed : colors.accent },
              (sending || !inputText.trim()) && styles.sendButtonDisabled,
            ]}
          >
            <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{t('conversation.sendButton')}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 14,
    paddingRight: 4,
  },
  container: {
    flex: 1,
  },
  ttlLabel: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  messageExpiry: {
    fontSize: 10,
    marginTop: 4,
  },
  ttlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 6,
  },
  ttlChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  messagesContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  messages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  placeholder: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  securityWarning: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  securityWarningText: {
    fontSize: 13,
    lineHeight: 18,
  },
  messageBubble: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'flex-start',
    maxWidth: '80%',
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    margin: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    paddingVertical: 6,
  },
  sendButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
});
