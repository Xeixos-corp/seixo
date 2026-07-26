import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

type BlockedPeersState = {
  blockedPeerIds: string[];
  setBlockedPeerIds: (ids: string[]) => void;
  addBlockedPeer: (peerUserId: string) => void;
  removeBlockedPeer: (peerUserId: string) => void;
  isBlocked: (peerUserId: string) => boolean;
};

// Local cache of the server-side blocked_peers table (transport/blocking.ts)
// — mirrors the conversationsStore pattern (persisted, refreshed from the
// server on registerIdentity()). The server, not this cache, is what
// actually enforces blocking (create_direct_channel RPC); this only drives
// what the UI hides without a round trip.
export const useBlockedPeersStore = create<BlockedPeersState>()(
  persist(
    (set, get) => ({
      blockedPeerIds: [],
      setBlockedPeerIds: (ids) => set({ blockedPeerIds: ids }),
      addBlockedPeer: (peerUserId) => {
        if (get().blockedPeerIds.includes(peerUserId)) return;
        set((state) => ({ blockedPeerIds: [...state.blockedPeerIds, peerUserId] }));
      },
      removeBlockedPeer: (peerUserId) => {
        set((state) => ({ blockedPeerIds: state.blockedPeerIds.filter((id) => id !== peerUserId) }));
      },
      isBlocked: (peerUserId) => get().blockedPeerIds.includes(peerUserId),
    }),
    {
      name: 'blocked-peers-store',
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
