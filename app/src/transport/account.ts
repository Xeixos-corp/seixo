import { supabase } from './supabaseClient';

/**
 * Calls the `delete-account` Edge Function (supabase/functions/delete-account),
 * which deletes the caller's own `auth.users` row via the Admin API — the
 * client can never do this directly, since that requires the service-role
 * key. Everything else (identities, prekeys, channel_members,
 * blocked_peers) cascades away via existing FK constraints — see the
 * function's own comments for the full explanation. Does NOT wipe local
 * state (SecureStore master key, persisted Zustand stores) — see
 * app/src/identity/deleteAccount.ts for the full flow, which calls this
 * first and then does that.
 */
export async function requestAccountDeletion(): Promise<void> {
  const { data, error } = await supabase.functions.invoke('delete-account');
  if (error) {
    throw new Error(`Account deletion failed: ${error.message}`);
  }
  if (data && typeof data === 'object' && 'error' in data) {
    throw new Error(`Account deletion failed: ${(data as { error: string }).error}`);
  }
}
