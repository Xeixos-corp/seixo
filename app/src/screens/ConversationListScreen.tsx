import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useConversationsStore, type Conversation, DEFAULT_TTL_SECONDS } from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { registerIdentity } from '../identity/registerIdentity';
import { createDirectChannel } from '../transport/channels';
import { claimPeerPrekeyBundle } from '../transport/identities';
import { isBlockedChannelError } from '../transport/blocking';
import { establishSession, isUntrustedIdentityError } from '../crypto';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'ConversationList'>;

export function ConversationListScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const conversations = useConversationsStore((state) => state.conversations);
  const addConversation = useConversationsStore((state) => state.addConversation);
  const isBlocked = useBlockedPeersStore((state) => state.isBlocked);
  const visibleConversations = conversations.filter((c) => !isBlocked(c.peerUserId));

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerButtons}>
          <Pressable onPress={() => navigation.navigate('BlockedPeers')} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 14 }}>{t('conversationList.blockedHeaderButton')}</Text>
          </Pressable>
          <Pressable onPress={() => navigation.navigate('Settings')} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 14 }}>{t('conversationList.settingsHeaderButton')}</Text>
          </Pressable>
        </View>
      ),
    });
  }, [navigation, colors.accent, t]);

  const [peerUserId, setPeerUserId] = useState('');
  const [starting, setStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleStartConversation = async () => {
    const trimmedPeerId = peerUserId.trim();
    if (!trimmedPeerId) return;

    setStarting(true);
    setErrorMessage(null);
    try {
      const { userId } = await registerIdentity();
      if (trimmedPeerId === userId) {
        throw new Error(t('conversationList.selfConversationError'));
      }

      const channelId = await createDirectChannel(trimmedPeerId);
      const bundle = await claimPeerPrekeyBundle(trimmedPeerId);
      establishSession(trimmedPeerId, bundle.deviceId, bundle);

      const conversation: Conversation = {
        channelId,
        peerUserId: trimmedPeerId,
        ttlSeconds: DEFAULT_TTL_SECONDS,
      };
      addConversation(conversation);
      setPeerUserId('');
      navigation.navigate('Conversation', conversation);
    } catch (error) {
      if (isUntrustedIdentityError(error)) {
        setErrorMessage(t('conversationList.untrustedIdentityError', { peerId: trimmedPeerId }));
      } else if (isBlockedChannelError(error)) {
        setErrorMessage(t('conversationList.blockedChannelError'));
      } else {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      setStarting(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.header, { color: colors.textPrimary }]}>{t('navigation.conversationList')}</Text>

      <View style={[styles.newConversationRow, { borderColor: colors.border }]}>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, borderColor: colors.border }]}
          placeholder={t('conversationList.peerIdPlaceholder')}
          placeholderTextColor={colors.textSecondary}
          value={peerUserId}
          onChangeText={setPeerUserId}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!starting}
        />
        <Pressable
          disabled={starting || !peerUserId.trim()}
          style={({ pressed }) => [
            styles.newConversationButton,
            { backgroundColor: pressed ? colors.accentPressed : colors.accent },
            (starting || !peerUserId.trim()) && styles.newConversationButtonDisabled,
          ]}
          onPress={handleStartConversation}
        >
          {starting ? (
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <Text style={[styles.newConversationButtonText, { color: colors.onAccent }]}>{t('conversationList.newButton')}</Text>
          )}
        </Pressable>
      </View>
      {errorMessage ? (
        <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
      ) : null}

      <FlatList
        data={visibleConversations}
        keyExtractor={(item) => item.channelId}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.conversationRow, { borderColor: colors.border }]}
            onPress={() => navigation.navigate('Conversation', item)}
          >
            <Text style={{ color: colors.textPrimary }} numberOfLines={1}>
              {item.peerUserId}
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('conversationList.emptyState')}
            </Text>
          </View>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 20,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 14,
    paddingRight: 4,
  },
  header: {
    fontSize: 24,
    fontWeight: '700',
    marginTop: 12,
    marginBottom: 16,
  },
  newConversationRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 8,
  },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
  },
  newConversationButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 64,
  },
  newConversationButtonDisabled: {
    opacity: 0.6,
  },
  newConversationButtonText: {
    fontSize: 14,
    fontWeight: '600',
  },
  errorText: {
    fontSize: 13,
    marginBottom: 8,
  },
  conversationRow: {
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  empty: {
    marginTop: 48,
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 20,
  },
});
