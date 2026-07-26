import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';

/**
 * Creates a 1:1 channel and adds both the caller and the peer as members.
 * Calls the `create_direct_channel` RPC (supabase/migrations/0003_direct_channels.sql)
 * rather than inserting into `channels`/`channel_members` directly — RLS
 * intentionally only lets a user insert their own membership row, so
 * there's no direct way to add a peer without this security-definer
 * function.
 */
export async function createDirectChannel(peerUserId: string): Promise<string> {
  const { data, error } = await supabase.rpc('create_direct_channel', { peer_id: peerUserId });
  if (error || !data) {
    throw new Error(`Could not create channel: ${error?.message ?? 'no channel id returned'}`);
  }
  return data as string;
}

/** Who else is in a channel besides the caller — used when notified of a new membership. */
export async function getOtherMember(channelId: string, selfUserId: string): Promise<string> {
  const { data, error } = await supabase
    .from('channel_members')
    .select('member_id')
    .eq('channel_id', channelId)
    .neq('member_id', selfUserId)
    .limit(1)
    .single();
  if (error || !data) {
    throw new Error(`Could not find the other member of channel ${channelId}: ${error?.message ?? 'not found'}`);
  }
  return data.member_id as string;
}

/**
 * Notifies when someone else adds the current user to a new channel (i.e.
 * the receiving side of createDirectChannel). Returns an unsubscribe
 * function.
 */
export function subscribeToMyNewMemberships(
  selfUserId: string,
  onNewChannel: (channelId: string) => void,
): () => void {
  const realtimeChannel: RealtimeChannel = supabase
    .channel(`channel-members-self-${selfUserId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'channel_members',
        filter: `member_id=eq.${selfUserId}`,
      },
      (payload) => {
        const channelId = (payload.new as { channel_id: string }).channel_id;
        onNewChannel(channelId);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(realtimeChannel);
  };
}
