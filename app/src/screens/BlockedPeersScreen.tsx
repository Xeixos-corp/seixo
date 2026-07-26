import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { registerIdentity } from '../identity/registerIdentity';
import { unblockPeer } from '../transport/blocking';

export function BlockedPeersScreen() {
  const { colors } = useAppTheme();
  const blockedPeerIds = useBlockedPeersStore((state) => state.blockedPeerIds);
  const removeBlockedPeer = useBlockedPeersStore((state) => state.removeBlockedPeer);
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleUnblock = async (peerUserId: string) => {
    setUnblockingId(peerUserId);
    setErrorMessage(null);
    try {
      const { userId } = await registerIdentity();
      await unblockPeer(userId, peerUserId);
      removeBlockedPeer(peerUserId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUnblockingId(null);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      {errorMessage ? (
        <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
      ) : null}
      <FlatList
        data={blockedPeerIds}
        keyExtractor={(id) => id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item }) => (
          <View style={[styles.row, { borderColor: colors.border }]}>
            <Text style={{ color: colors.textPrimary, flex: 1 }} numberOfLines={1}>
              {item}
            </Text>
            <Pressable
              disabled={unblockingId === item}
              onPress={() => handleUnblock(item)}
              style={({ pressed }) => [
                styles.unblockButton,
                { backgroundColor: pressed ? colors.accentPressed : colors.accent },
              ]}
            >
              <Text style={{ color: colors.onAccent, fontWeight: '600', fontSize: 13 }}>
                {unblockingId === item ? '...' : 'Desbloquear'}
              </Text>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              Não bloqueaste ninguém ainda.
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
  },
  listContent: {
    paddingHorizontal: 20,
    paddingTop: 12,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  unblockButton: {
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
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
