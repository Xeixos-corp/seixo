import { supabase } from './supabaseClient';

// App Store Review Guideline 1.2 requires "the ability to block abusive
// users from the service" for any app with user-to-user communication.
// Enforcement lives server-side (supabase/migrations/0007_blocking.sql —
// create_direct_channel rejects new channels in either direction once
// blocked); this module is just the CRUD layer the client uses to manage
// its own block list and to decide what to hide locally (see
// store/blockedPeersStore.ts).

export async function fetchBlockedPeerIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('blocked_peers')
    .select('blocked_user_id')
    .eq('owner_id', userId);
  if (error) throw error;
  return (data ?? []).map((row) => row.blocked_user_id as string);
}

export async function blockPeer(userId: string, peerUserId: string): Promise<void> {
  const { error } = await supabase
    .from('blocked_peers')
    .insert({ owner_id: userId, blocked_user_id: peerUserId });
  if (error) throw error;
}

export async function unblockPeer(userId: string, peerUserId: string): Promise<void> {
  const { error } = await supabase
    .from('blocked_peers')
    .delete()
    .eq('owner_id', userId)
    .eq('blocked_user_id', peerUserId);
  if (error) throw error;
}

/** RPC errors surface the Postgres RAISE EXCEPTION text as error.message — see 0007_blocking.sql. */
export function isBlockedChannelError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('blocked: cannot start a conversation');
}
