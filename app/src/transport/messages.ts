import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import { decodeEnvelope, encodeEnvelope } from '../crypto/messageCodec';
import type { EncryptedEnvelope } from '../crypto';

// Fallback only — real callers pass the conversation's chosen TTL
// (see app/src/store/conversationsStore.ts). The schema requires expires_at
// on every row regardless (supabase/migrations/0001_init.sql), so something
// has to be set even if a caller forgets to pass one.
export const DEFAULT_MESSAGE_TTL_SECONDS = 24 * 60 * 60;

export type FetchedMessage = {
  id: string;
  createdAt: string;
  expiresAt: string;
  envelope: EncryptedEnvelope;
};

/**
 * Returns the inserted row's id/createdAt/expiresAt so the sender can record
 * the message locally (with the plaintext it already has) without waiting
 * for — or decrypting — the realtime echo of its own insert. A party can't
 * decrypt its own sent ciphertext (sending and receiving use separate
 * Double Ratchet chain keys), so that echo must never reach decryptMessage.
 */
export async function sendMessage(
  channelId: string,
  envelope: EncryptedEnvelope,
  ttlSeconds: number = DEFAULT_MESSAGE_TTL_SECONDS,
): Promise<{ id: string; createdAt: string; expiresAt: string }> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const { data, error } = await supabase
    .from('messages')
    .insert({
      channel_id: channelId,
      ciphertext: encodeEnvelope(envelope),
      expires_at: expiresAt,
    })
    .select('id, created_at, expires_at')
    .single();
  if (error || !data) {
    throw error ?? new Error('Insert returned no row');
  }
  return {
    id: data.id as string,
    createdAt: data.created_at as string,
    expiresAt: data.expires_at as string,
  };
}

export async function fetchMessages(channelId: string): Promise<FetchedMessage[]> {
  const { data, error } = await supabase
    .from('messages')
    .select('id, ciphertext, created_at, expires_at')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: true });
  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id as string,
    createdAt: row.created_at as string,
    expiresAt: row.expires_at as string,
    envelope: decodeEnvelope(row.ciphertext as string),
  }));
}

/**
 * Removes a message from the server outright, ahead of its TTL — the "I sent
 * that by mistake" case. Allowed by the RLS policy any channel member gets
 * ("messages are deletable by channel members (manual delete / burn)",
 * supabase/migrations/0001_init.sql), which was written for exactly this.
 *
 * This reliably removes the server's copy. Whether it also disappears from
 * the peer's phone is best-effort: they only drop their local copy if their
 * client is subscribed when the delete lands (see subscribeToChannelMessages
 * below). If they were offline at that moment, their copy survives — and no
 * deletion of any kind can undo a screenshot. The UI must not promise more
 * than that.
 */
export async function deleteMessage(messageId: string): Promise<void> {
  const { error } = await supabase.from('messages').delete().eq('id', messageId);
  if (error) throw error;
}

/**
 * Notifies on messages inserted into, or deleted from, a channel. Returns an
 * unsubscribe function.
 *
 * The delete half depends on `messages` having REPLICA IDENTITY FULL
 * (supabase/migrations/0009_...): without it Postgres only puts the primary
 * key in the WAL, so the channel_id filter below has nothing to match and
 * Realtime cannot evaluate the RLS policy to decide who may receive it.
 */
export function subscribeToChannelMessages(
  channelId: string,
  onInsert: (message: FetchedMessage) => void,
  onDelete?: (messageId: string) => void,
): () => void {
  const realtimeChannel: RealtimeChannel = supabase
    // Unique per subscription, not just per channel. `supabase.channel(topic)`
    // hands back the *existing* channel object for a topic already in use, and
    // calling .on() on one that has already subscribed throws
    // "cannot add postgres_changes callbacks ... after subscribe()". Since
    // removeChannel() below is asynchronous, a resubscribe (useMessageSync
    // rebuilds them whenever a conversation is added or removed) can easily
    // land while the old channel is still registered -- which is exactly how
    // this failed for channel-members-self.
    .channel(`messages-channel-${channelId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      (payload) => {
        const row = payload.new as {
          id: string;
          ciphertext: string;
          created_at: string;
          expires_at: string;
        };
        onInsert({
          id: row.id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          envelope: decodeEnvelope(row.ciphertext),
        });
      },
    )
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      (payload) => {
        const row = payload.old as { id?: string };
        if (row?.id) onDelete?.(row.id);
      },
    )
    .subscribe();

  return () => {
    supabase.removeChannel(realtimeChannel);
  };
}
