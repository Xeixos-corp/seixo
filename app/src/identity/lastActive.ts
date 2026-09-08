import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../transport/supabaseClient';

const STORAGE_KEY = 'seixo.last-active-marked.v1';

/**
 * Tells the server this account is still in use, so the abandoned-account
 * purge leaves it alone (supabase/migrations/0016_purge_abandoned_accounts.sql).
 *
 * A date, never a time. Whether an account is abandoned needs day precision;
 * anything finer is a record of when someone uses their phone, which is not
 * ours to keep. The column is a `date` server-side too, so even a careless
 * caller cannot write more than that.
 *
 * Written at most once a day: the local marker is checked first, so opening
 * the app fifty times sends one update, not fifty.
 */
export async function markAccountActive(userId: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);

  try {
    if ((await AsyncStorage.getItem(STORAGE_KEY)) === today) return;
  } catch {
    // A failed read just means we write again, which is harmless.
  }

  const { error } = await supabase
    .from('identities')
    .update({ last_active_on: today })
    .eq('user_id', userId);

  if (error) {
    // Non-fatal on purpose. Failing to mark activity risks the account being
    // purged after six months of failures, which is not a today problem, and
    // is a far better outcome than blocking startup over it.
    console.warn('[lastActive] failed to mark account active', error.message);
    return;
  }

  try {
    await AsyncStorage.setItem(STORAGE_KEY, today);
  } catch {
    // Same: the cost is one redundant update tomorrow.
  }
}
