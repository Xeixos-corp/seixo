import { supabase } from '../transport/supabaseClient';

/**
 * Stores this device's push token, together with the exact text the server
 * should display for it.
 *
 * The strings are sent from here rather than composed server-side on purpose:
 * it keeps "which language does this user read" off the server. See
 * supabase/migrations/0010_push_notifications.sql.
 */
export async function upsertPushToken(
  userId: string,
  token: string,
  notificationTitle: string,
  notificationBody: string,
): Promise<void> {
  // Claim the token for this identity first. A push token belongs to the
  // *device*, not to an identity -- so creating a new identity on a phone
  // that already had one used to leave the old row in place, pointing the
  // same token at a user_id the app no longer uses. The phone then got
  // notifications for a conversation it could not show. Deleting any other
  // owner of this token keeps one device to one identity.
  const { error: claimError } = await supabase
    .from('push_tokens')
    .delete()
    .eq('token', token)
    .neq('user_id', userId);
  if (claimError) throw new Error(claimError.message);

  const { error } = await supabase.from('push_tokens').upsert(
    {
      user_id: userId,
      token,
      notification_title: notificationTitle,
      notification_body: notificationBody,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
  if (error) throw new Error(error.message);
}

export async function deletePushToken(userId: string): Promise<void> {
  const { error } = await supabase.from('push_tokens').delete().eq('user_id', userId);
  if (error) throw new Error(error.message);
}
