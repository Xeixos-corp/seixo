import { requestAccountDeletion } from '../transport/account';
import { supabase } from '../transport/supabaseClient';
import { wipeLocalSignalStore } from '../crypto';
import { clearMasterKeyBase64 } from '../crypto/masterKey';
import { resetRegisteredIdentity } from './registerIdentity';
import { clearPrekeyAllocation } from './prekeyState';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import { clearFailedMessageCache } from '../messaging/ingest';
import { resetPushRegistration } from '../notifications/usePushRegistration';
import { useConversationsStore } from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { useMessagesStore } from '../store/messagesStore';

/**
 * App Store Guideline 5.1.1(v): full account deletion, not just a local
 * reset. Order matters — server-side first, then local:
 *
 * 1. requestAccountDeletion() — deletes the auth.users row via the
 *    delete-account Edge Function, cascading identities/prekeys/
 *    channel_members/blocked_peers server-side (see that function and
 *    supabase/migrations/0007_blocking.sql).
 * 2. Only once that has actually succeeded: sign out locally, wipe the
 *    on-disk Signal Protocol store and its master key, clear persisted
 *    Zustand stores, and un-memoize registerIdentity() so a later
 *    "Criar identidade" genuinely starts fresh instead of resurrecting the
 *    deleted identity from local disk.
 *
 * If step 1 fails, none of step 2 runs — a failed deletion should leave the
 * user with an intact, working identity and a clear error, not a
 * half-wiped local state pointing at a server account that may or may not
 * still exist.
 */
export async function deleteAccountAndAllLocalData(): Promise<void> {
  await requestAccountDeletion();

  await supabase.auth.signOut();
  wipeLocalSignalStore();
  await clearMasterKeyBase64();
  resetRegisteredIdentity();
  // Without this, the next identity would inherit this one's prekey
  // allocation record and skip publishing a bundle entirely -- leaving a
  // brand new identity with no prekeys on the server, unreachable by anyone.
  await clearPrekeyAllocation();

  useConversationsStore.setState({ conversations: [] });
  useBlockedPeersStore.setState({ blockedPeerIds: [] });
  useMessagesStore.setState({ messagesByChannel: {} });
  useSecurityWarningsStore.setState({ untrustedByChannel: {} });
  clearFailedMessageCache();
  // The server-side row is already gone (push_tokens cascades from
  // identities, see supabase/migrations/0011_push_tokens_cascade.sql); this
  // just makes sure the next identity on this device registers a fresh token
  // rather than assuming one is still published.
  resetPushRegistration();
}
