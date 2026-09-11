import React, { useEffect } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { useConversationsStore, conversationDisplayName } from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { usePendingShareStore } from '../store/pendingShareStore';

type Props = NativeStackScreenProps<RootStackParamList, 'ShareTarget'>;

/**
 * "Share to…": choosing the conversation for something shared from another
 * app.
 *
 * Choosing does not send. It opens the conversation with the shared text in
 * the input box, where the person can add to it, change it or delete it, and
 * it leaves only when they press send. Anything else -- a share that went
 * straight out -- would put a message in someone's conversation that the
 * sender never saw in context.
 */
export function ShareTargetScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const text = usePendingShareStore((state) => state.text);
  const conversations = useConversationsStore((state) => state.conversations);
  const blockedPeerIds = useBlockedPeersStore((state) => state.blockedPeerIds);
  const visible = conversations.filter((conversation) => !blockedPeerIds.includes(conversation.peerUserId));

  // Leaving this screen any way at all -- a choice, cancel, or swiping back --
  // discards the pending share, so it cannot resurface later somewhere the
  // person no longer expects it.
  useEffect(() => () => usePendingShareStore.getState().clear(), []);

  useEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <Pressable onPress={() => navigation.goBack()} hitSlop={8}>
          <Text style={{ color: colors.accent, fontSize: 16 }}>{t('conversation.cancel')}</Text>
        </Pressable>
      ),
    });
  }, [navigation, colors.accent, t]);

  const choose = (channelId: string, peerUserId: string) => {
    navigation.replace('Conversation', { channelId, peerUserId, initialDraft: text ?? '' });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      {text ? (
        <View style={[styles.preview, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
          <Text style={{ color: colors.textPrimary, fontSize: 14 }} numberOfLines={3}>
            {text}
          </Text>
        </View>
      ) : null}
      <Text style={[styles.intro, { color: colors.textSecondary }]}>{t('share.intro')}</Text>

      <FlatList
        data={visible}
        keyExtractor={(item) => item.channelId}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('share.empty')}</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => choose(item.channelId, item.peerUserId)}
            style={({ pressed }) => [
              styles.row,
              { borderColor: colors.border, backgroundColor: pressed ? colors.surfaceAlt : 'transparent' },
            ]}
          >
            <Text style={{ color: colors.textPrimary, fontSize: 16, fontWeight: '500' }} numberOfLines={1}>
              {conversationDisplayName(item, t('conversationList.unnamedGroup'))}
            </Text>
          </Pressable>
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: 16 },
  preview: { borderWidth: 1, borderRadius: 12, padding: 12, marginTop: 16 },
  intro: { fontSize: 13, lineHeight: 18, marginVertical: 12 },
  empty: { fontSize: 14, textAlign: 'center', marginTop: 32 },
  row: { paddingVertical: 16, paddingHorizontal: 4, borderBottomWidth: StyleSheet.hairlineWidth },
});
