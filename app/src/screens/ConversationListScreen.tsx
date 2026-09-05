import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Modal,
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
import {
  useConversationsStore,
  conversationDisplayName,
  type Conversation,
} from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { startConversationWithPeer, SelfConversationError } from '../identity/startConversation';
import { isBlockedChannelError } from '../transport/blocking';
import { isUntrustedIdentityError } from '../crypto';
import { MyIdCard } from '../components/MyIdCard';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'ConversationList'>;

export function ConversationListScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const conversations = useConversationsStore((state) => state.conversations);
  const isBlocked = useBlockedPeersStore((state) => state.isBlocked);
  const visibleConversations = conversations.filter((c) => !isBlocked(c.peerUserId));

  useEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <View style={styles.headerButtons}>
          <Pressable onPress={() => navigation.navigate('ScanQr')} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 14 }}>{t('conversationList.scanHeaderButton')}</Text>
          </Pressable>
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

  // Rename flow. Long-pressing a row opens this; the label is stored locally
  // only (see conversationsStore) and never leaves the device.
  const setConversationNickname = useConversationsStore((state) => state.setConversationNickname);
  const [renaming, setRenaming] = useState<Conversation | null>(null);
  const [nicknameDraft, setNicknameDraft] = useState('');

  const openRename = (conversation: Conversation) => {
    setRenaming(conversation);
    setNicknameDraft(conversation.nickname ?? '');
  };

  const confirmRename = () => {
    if (renaming) {
      setConversationNickname(renaming.channelId, nicknameDraft);
    }
    setRenaming(null);
  };

  const handleStartConversation = async () => {
    const trimmedPeerId = peerUserId.trim();
    if (!trimmedPeerId) return;

    setStarting(true);
    setErrorMessage(null);
    try {
      const conversation = await startConversationWithPeer(trimmedPeerId);
      setPeerUserId('');
      navigation.navigate('Conversation', conversation);
    } catch (error) {
      if (error instanceof SelfConversationError) {
        setErrorMessage(t('conversationList.selfConversationError'));
      } else if (isUntrustedIdentityError(error)) {
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
            onLongPress={() => openRename(item)}
            delayLongPress={350}
          >
            <Text style={[styles.conversationName, { color: colors.textPrimary }]} numberOfLines={1}>
              {conversationDisplayName(item)}
            </Text>
            {item.nickname ? (
              <Text style={[styles.conversationId, { color: colors.textSecondary }]} numberOfLines={1}>
                {item.peerUserId}
              </Text>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('conversationList.emptyState')}
            </Text>
            <View style={styles.myIdCardWrapper}>
              <MyIdCard />
            </View>
          </View>
        }
      />
      <Modal
        visible={renaming !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setRenaming(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={[styles.modalCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('conversationList.renameTitle')}
            </Text>
            <Text style={[styles.modalHint, { color: colors.textSecondary }]}>
              {t('conversationList.renameHint')}
            </Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, borderColor: colors.border }]}
              placeholder={t('conversationList.renamePlaceholder')}
              placeholderTextColor={colors.textSecondary}
              value={nicknameDraft}
              onChangeText={setNicknameDraft}
              autoFocus
              maxLength={40}
            />
            <View style={styles.modalButtons}>
              <Pressable onPress={() => setRenaming(null)} hitSlop={8}>
                <Text style={{ color: colors.textSecondary, fontSize: 15 }}>
                  {t('conversationList.renameCancel')}
                </Text>
              </Pressable>
              <Pressable onPress={confirmRename} hitSlop={8}>
                <Text style={{ color: colors.accent, fontSize: 15, fontWeight: '600' }}>
                  {t('conversationList.renameSave')}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  conversationName: {
    fontSize: 16,
  },
  conversationId: {
    fontSize: 11,
    marginTop: 2,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 20,
    gap: 12,
  },
  modalTitle: {
    fontSize: 17,
    fontWeight: '700',
  },
  modalHint: {
    fontSize: 13,
    lineHeight: 18,
  },
  // Same look as `input`, minus its `flex: 1`. That property means "fill the
  // remaining width" in the horizontal new-conversation row it was written
  // for, but "fill the remaining height" here in a vertical card that sizes
  // to its content -- which collapsed this field to zero height. It still
  // took keystrokes, so text went in and saving worked; you just could not
  // see what you were typing.
  modalInput: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
  },
  modalButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 20,
    marginTop: 4,
  },
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
  myIdCardWrapper: {
    marginTop: 24,
    width: '100%',
  },
  emptyText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 20,
  },
});
