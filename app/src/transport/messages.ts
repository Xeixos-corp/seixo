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

/** Notifies on new messages inserted into a channel. Returns an unsubscribe function. */
export function subscribeToChannelMessages(
  channelId: string,
  onInsert: (message: FetchedMessage) => void,
): () => void {
  const realtimeChannel: RealtimeChannel = supabase
    .channel(`messages-channel-${channelId}`)
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
    .subscribe();

  return () => {
    supabase.removeChannel(realtimeChannel);
  };
}
