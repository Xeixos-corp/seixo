import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppTheme } from '../theme/ThemeProvider';
import { useMessagesStore } from '../store/messagesStore';
import { useConversationsStore, DEFAULT_TTL_SECONDS } from '../store/conversationsStore';
import { fetchMessages, sendMessage, subscribeToChannelMessages, type FetchedMessage } from '../transport/messages';
import { encryptMessage, decryptMessage, isUntrustedIdentityError } from '../crypto';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

const REMOTE_DEVICE_ID = 1; // single device per identity for now

const TTL_OPTIONS: Array<{ label: string; seconds: number }> = [
  { label: '30s', seconds: 30 },
  { label: '5 min', seconds: 5 * 60 },
  { label: '1 hora', seconds: 60 * 60 },
  { label: '1 dia', seconds: 24 * 60 * 60 },
  { label: '1 semana', seconds: 7 * 24 * 60 * 60 },
];

export function ConversationScreen({ route }: Props) {
  const { channelId, peerUserId } = route.params;
  const { colors } = useAppTheme();
  const messages = useMessagesStore((state) => state.messagesByChannel[channelId] ?? []);
  const addMessage = useMessagesStore((state) => state.addMessage);
  const removeMessage = useMessagesStore((state) => state.removeMessage);
  const ttlSeconds = useConversationsStore(
    (state) => state.conversations.find((c) => c.channelId === channelId)?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  );
  const setConversationTtl = useConversationsStore((state) => state.setConversationTtl);

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

  const decryptAndStore = useCallback(
    (fetched: FetchedMessage) => {
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
          setSecurityWarning(
            `A chave de segurança de ${peerUserId} mudou desde a última conversa. Esta mensagem não foi decifrada — confirma com a outra pessoa antes de continuar.`,
          );
        }
        console.error('[ConversationScreen] failed to decrypt message', fetched.id, error);
      }
    },
    [channelId, peerUserId, addMessage, scheduleExpiry],
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
        setSecurityWarning(
          `A chave de segurança de ${peerUserId} mudou desde a última conversa. A mensagem não foi enviada — confirma com a outra pessoa antes de continuar.`,
        );
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
                  {option.label}
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
            </View>
          )}
          ListEmptyComponent={
            <View style={styles.messages}>
              <Text style={[styles.placeholder, { color: colors.textSecondary }]}>
                Ainda sem mensagens nesta conversa.
              </Text>
            </View>
          }
        />

        <View style={[styles.inputBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput
            style={[styles.input, { color: colors.textPrimary }]}
            placeholder="Escrever mensagem…"
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
            <Text style={{ color: colors.onAccent, fontWeight: '600' }}>Enviar</Text>
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
  container: {
    flex: 1,
  },
  ttlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 10,
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
