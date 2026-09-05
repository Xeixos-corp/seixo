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

/**
 * Leaves a conversation by deleting only this user's own membership row,
 * which is exactly what the RLS policy allows ("channel membership is
 * self-deletable (leave conversation)", supabase/migrations/0001_init.sql).
 *
 * Done server-side rather than just hiding the conversation locally, because
 * hiding it would be worse than useless: nothing re-adds a hidden
 * conversation when a new message arrives, so the peer would keep writing
 * into a channel this user silently never sees again. Leaving is at least
 * honest about what happened -- their messages can no longer reach this
 * user, and either side can start a fresh conversation later.
 */
export async function leaveChannel(channelId: string, selfUserId: string): Promise<void> {
  const { error } = await supabase
    .from('channel_members')
    .delete()
    .eq('channel_id', channelId)
    .eq('member_id', selfUserId);
  if (error) throw error;
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
// The channel opened by the most recent call, so a later call can tear it
// down. See the comment in subscribeToMyNewMemberships for why this matters.
let currentMembershipChannel: RealtimeChannel | null = null;

export function subscribeToMyNewMemberships(
  selfUserId: string,
  onNewChannel: (channelId: string) => void,
): () => void {
  // This used to open a channel named `channel-members-self-<userId>`, which
  // is stable per user and therefore collides with itself. supabase-js hands
  // back the existing instance for a topic it already knows, and calling
  // .on() on one that has already been subscribed throws:
  //
  //   cannot add postgres_changes callbacks for realtime:channel-members-self-…
  //   after subscribe()
  //
  // That turned any transient failure into a permanent one. registerIdentity
  // clears its memo when doRegister fails so the next call can retry — but
  // the retry re-ran this function, hit the already-subscribed channel, and
  // failed for a *different* reason than the original. Every subsequent
  // attempt then failed the same way, so a one-second network blip left the
  // app unable to register until it was restarted. That is how it was found:
  // Settings showed "could not load your ID" and retrying never helped.
  //
  // Fixed by giving each subscription its own topic and tearing down the
  // previous one, so a repeat call can never collide with itself.
  if (currentMembershipChannel) {
    void supabase.removeChannel(currentMembershipChannel);
    currentMembershipChannel = null;
  }

  const realtimeChannel: RealtimeChannel = supabase
    .channel(`channel-members-self-${selfUserId}-${Date.now()}`)
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

  currentMembershipChannel = realtimeChannel;

  return () => {
    if (currentMembershipChannel === realtimeChannel) {
      currentMembershipChannel = null;
    }
    supabase.removeChannel(realtimeChannel);
  };
}
