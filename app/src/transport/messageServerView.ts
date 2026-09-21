import { supabase } from './supabaseClient';
import { isGroupMessage } from '../messaging/groupEnvelope';

export type MessageServerView =
  /** The row is gone: expired, deleted, or (for voice and photos) past its day. */
  | { found: false }
  | {
      found: true;
      channelId: string;
      createdAt: string;
      expiresAt: string;
      /** Whether the row asked not to notify (reactions, deletions, notices). */
      silent: boolean;
      /** Size of the stored ciphertext, in bytes, exactly as the server has it. */
      bytes: number;
      /** The first characters of the ciphertext, as the server stores them. */
      sample: string;
      /**
       * What a group message carries in the clear: who sent it, and which
       * members it has a copy for. Null for a one-to-one message, where
       * neither is in the row.
       */
      group: { senderUserId: string; recipientCount: number } | null;
      /** The photo's stored file, when the message has one and it still exists. */
      file: { bytes: number; createdAt: string | null; lastAccessedAt: string | null } | null;
    };

/**
 * Reads one message back from the server, as the server holds it.
 *
 * Through the same row-level security as any other read: the message row is
 * visible only to members of its conversation, and so is its file. Nothing is
 * summarised or computed server-side -- the size is measured from the
 * ciphertext actually returned, and the group fields are read out of it, so
 * the screen shows what is there rather than what the app believes is there.
 *
 * The ciphertext is downloaded to measure it. For a voice message that is up
 * to a megabyte or so; it is asked for by a person tapping a menu item, once,
 * and an estimate would defeat the purpose of the screen.
 */
export async function fetchMessageServerView(messageId: string): Promise<MessageServerView> {
  const [row, listing] = await Promise.all([
    supabase
      .from('messages')
      .select('channel_id, ciphertext, created_at, expires_at, silent')
      .eq('id', messageId)
      .maybeSingle(),
    supabase.storage.from('attachments').list('', { limit: 1, search: messageId }),
  ]);
  if (row.error) throw new Error(row.error.message);
  if (listing.error) throw new Error(listing.error.message);
  if (!row.data) return { found: false };

  const ciphertext = row.data.ciphertext as string;
  let group: { senderUserId: string; recipientCount: number } | null = null;
  if (isGroupMessage(ciphertext)) {
    try {
      const packed = JSON.parse(ciphertext) as { f?: unknown; to?: Record<string, unknown> };
      if (typeof packed.f === 'string') {
        group = { senderUserId: packed.f, recipientCount: Object.keys(packed.to ?? {}).length };
      }
    } catch {
      // Not parseable after all; shown as an ordinary ciphertext.
    }
  }

  const object = (listing.data ?? []).find((item) => item.name === messageId);
  const size = Number((object?.metadata as { size?: unknown } | undefined)?.size);

  return {
    found: true,
    channelId: row.data.channel_id as string,
    createdAt: row.data.created_at as string,
    expiresAt: row.data.expires_at as string,
    silent: row.data.silent === true,
    // ASCII (base64 and JSON), so characters are bytes.
    bytes: ciphertext.length,
    sample: ciphertext.slice(0, 48),
    group,
    file: object
      ? {
          bytes: Number.isFinite(size) ? size : 0,
          createdAt: object.created_at ?? null,
          lastAccessedAt: object.last_accessed_at ?? null,
        }
      : null,
  };
}
