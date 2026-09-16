import { supabase } from './supabaseClient';

/**
 * Everything the database holds about one account, read from the database.
 *
 * Nothing here is privileged: every query below is one the app could already
 * make, allowed by the same row-level security that decides what any account
 * may see. That is the point. A screen built on a special endpoint would be
 * showing what the server chose to admit to; this shows what is actually
 * there, through the same door everyone else uses.
 *
 * It deliberately reads rather than summarises server-side. A count computed
 * in a function could be wrong, or could drift from the table, and nobody
 * looking at the screen would be able to tell.
 */
export type ServerFootprint = {
  userId: string;
  identityPublicKey: string;
  createdAt: string;
  /** A date, never a time. The column is a `date` for that reason. */
  lastActiveOn: string | null;
  registrationId: number | null;
  /** Whether an encrypted display name was ever published. */
  hasDisplayNameCiphertext: boolean;
  signedPrekeys: number;
  oneTimePrekeys: number;
  channels: {
    channelId: string;
    kind: 'direct' | 'group';
    createdAt: string;
    muted: boolean;
    members: number;
    /** Messages still on the server for this channel, all of them ciphertext. */
    messages: number;
    /** When the earliest of them expires, or null when there are none. */
    firstExpiry: string | null;
  }[];
  pushToken: {
    title: string;
    body: string;
    groupBody: string | null;
    sound: string | null;
    /** Also only a date. */
    updatedAt: string | null;
  } | null;
  blockedPeers: number;
};

/** Turns the first reported failure into a thrown error naming what failed. */
function failFast(results: Record<string, { message: string } | null>): void {
  for (const [what, error] of Object.entries(results)) {
    if (error) throw new Error(`${what}: ${error.message}`);
  }
}

export async function fetchServerFootprint(userId: string): Promise<ServerFootprint> {
  const { data: identity, error: identityError } = await supabase
    .from('identities')
    .select('user_id, identity_public_key, created_at, last_active_on, registration_id, display_name_ciphertext')
    .eq('user_id', userId)
    .single();
  if (identityError || !identity) {
    throw new Error(identityError?.message ?? 'no identity row');
  }

  const [signed, oneTime, blocked, memberships, pushTokens] = await Promise.all([
    supabase.from('signed_prekeys').select('id', { count: 'exact', head: true }).eq('owner_id', userId),
    supabase.from('one_time_prekeys').select('id', { count: 'exact', head: true }).eq('owner_id', userId),
    supabase.from('blocked_peers').select('blocked_user_id', { count: 'exact', head: true }).eq('owner_id', userId),
    supabase.from('channel_members').select('channel_id, muted').eq('member_id', userId),
    supabase
      .from('push_tokens')
      .select('notification_title, notification_body, notification_group_body, notification_sound, updated_at')
      .eq('user_id', userId)
      .maybeSingle(),
  ]);

  // Every failure is fatal here, and that is the whole design. A supabase
  // query reports its failure in the result rather than by throwing, so a
  // denied or dropped request would otherwise arrive as a count of zero --
  // and this screen would calmly report "nothing blocked", "no keys", which
  // is exactly the comfortable falsehood it exists to prevent. Better to show
  // nothing and say why.
  failFast({
    'signed prekeys': signed.error,
    'one-time prekeys': oneTime.error,
    'blocked peers': blocked.error,
    memberships: memberships.error,
    'push token': pushTokens.error,
  });

  const channelIds = (memberships.data ?? []).map((row) => row.channel_id as string);
  const mutedIds = new Set(
    (memberships.data ?? []).filter((row) => row.muted === true).map((row) => row.channel_id as string),
  );

  const channels: ServerFootprint['channels'] = [];
  if (channelIds.length > 0) {
    const [channelRows, memberRows, messageRows] = await Promise.all([
      supabase.from('channels').select('id, kind, created_at').in('id', channelIds),
      supabase.from('channel_members').select('channel_id, member_id').in('channel_id', channelIds),
      // Only the two columns needed to count and to find the earliest expiry.
      // Never the ciphertext: pulling every message body to draw a number on a
      // screen would be a waste and, on a slow connection, a long one.
      supabase.from('messages').select('channel_id, expires_at').in('channel_id', channelIds),
    ]);

    failFast({
      channels: channelRows.error,
      members: memberRows.error,
      messages: messageRows.error,
    });

    const memberCounts = new Map<string, number>();
    for (const row of memberRows.data ?? []) {
      const id = row.channel_id as string;
      memberCounts.set(id, (memberCounts.get(id) ?? 0) + 1);
    }

    const messageCounts = new Map<string, number>();
    const earliestExpiry = new Map<string, string>();
    for (const row of messageRows.data ?? []) {
      const id = row.channel_id as string;
      messageCounts.set(id, (messageCounts.get(id) ?? 0) + 1);
      const expiry = row.expires_at as string | null;
      if (!expiry) continue;
      const current = earliestExpiry.get(id);
      if (!current || Date.parse(expiry) < Date.parse(current)) earliestExpiry.set(id, expiry);
    }

    for (const row of channelRows.data ?? []) {
      const id = row.id as string;
      channels.push({
        channelId: id,
        kind: ((row.kind as string) ?? 'direct') as 'direct' | 'group',
        createdAt: row.created_at as string,
        muted: mutedIds.has(id),
        members: memberCounts.get(id) ?? 0,
        messages: messageCounts.get(id) ?? 0,
        firstExpiry: earliestExpiry.get(id) ?? null,
      });
    }
    channels.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  return {
    userId: identity.user_id as string,
    identityPublicKey: identity.identity_public_key as string,
    createdAt: identity.created_at as string,
    lastActiveOn: (identity.last_active_on as string | null) ?? null,
    registrationId: (identity.registration_id as number | null) ?? null,
    hasDisplayNameCiphertext: Boolean(identity.display_name_ciphertext),
    signedPrekeys: signed.count ?? 0,
    oneTimePrekeys: oneTime.count ?? 0,
    channels,
    pushToken: pushTokens.data
      ? {
          title: pushTokens.data.notification_title as string,
          body: pushTokens.data.notification_body as string,
          groupBody: (pushTokens.data.notification_group_body as string | null) ?? null,
          sound: (pushTokens.data.notification_sound as string | null) ?? null,
          updatedAt: (pushTokens.data.updated_at as string | null) ?? null,
        }
      : null,
    blockedPeers: blocked.count ?? 0,
  };
}
