import { supabase } from './supabaseClient';
import type { OneTimePrekeyPublic, PreKeyBundleData } from '../crypto';

// Fixed local prekey ids for the signed/Kyber prekey and the bundle's own
// one-time prekey: publishPrekeyBundle always deletes-then-inserts, so
// reusing the same ids every registerIdentity() call is safe — no stale
// prekey with the same id can exist server-side by the time a fresh one is
// published. The one-time prekey POOL (ids below) uses distinct ids per
// slot instead, since — unlike the signed/Kyber prekey — every id in the
// pool must stay individually claimable (see EXTRA_ONE_TIME_PREKEY_IDS).
export const LOCAL_ONE_TIME_PREKEY_ID = 1;
export const LOCAL_SIGNED_PREKEY_ID = 1;
export const LOCAL_KYBER_PREKEY_ID = 1;

// Ids 2..20: a pool of 19 extra one-time prekeys published alongside the
// bundle's own id-1 prekey (20 total), so that up to 20 peers can each start
// a session with this identity before it needs to republish. Without this
// pool, only the FIRST peer to claim a bundle after each registerIdentity()
// call gets a one-time prekey at all — claimPeerPrekeyBundle deletes on
// claim, so the table is empty for the second peer onward. See
// packages/signal-native/rust/src/lib.rs::generate_extra_one_time_prekeys.
export const EXTRA_ONE_TIME_PREKEY_IDS = Array.from({ length: 19 }, (_, i) => i + 2);

/** How many unclaimed one-time prekeys this identity still has published. */
export async function countMyOneTimePrekeys(userId: string): Promise<number> {
  const { count, error } = await supabase
    .from('one_time_prekeys')
    .select('*', { count: 'exact', head: true })
    .eq('owner_id', userId);
  if (error) throw error;
  return count ?? 0;
}

/**
 * Adds one-time prekeys without touching the ones already published.
 * Distinct from publishPrekeyBundle, which deletes first: replenishment must
 * never remove prekeys a peer may already have claimed the public half of.
 */
export async function insertOneTimePrekeys(
  userId: string,
  prekeys: OneTimePrekeyPublic[],
): Promise<void> {
  if (prekeys.length === 0) return;
  const { error } = await supabase.from('one_time_prekeys').insert(
    prekeys.map((prekey) => ({
      owner_id: userId,
      prekey_id: prekey.id,
      public_key: prekey.publicKeyBase64,
    })),
  );
  if (error) throw error;
}

export async function signInAnonymouslyIfNeeded(): Promise<string> {
  const { data: sessionData } = await supabase.auth.getSession();
  if (sessionData.session?.user) {
    return sessionData.session.user.id;
  }

  const { data, error } = await supabase.auth.signInAnonymously();
  if (error || !data.user) {
    throw new Error(`Anonymous sign-in failed: ${error?.message ?? 'no user returned'}`);
  }
  return data.user.id;
}

export async function upsertMyIdentity(
  userId: string,
  identityPublicKeyBase64: string,
  registrationId: number,
): Promise<void> {
  const { error } = await supabase.from('identities').upsert({
    user_id: userId,
    identity_public_key: identityPublicKeyBase64,
    registration_id: registrationId,
  });
  if (error) throw error;
}

export async function publishPrekeyBundle(
  userId: string,
  bundle: PreKeyBundleData,
  extraOneTimePrekeys: OneTimePrekeyPublic[] = [],
): Promise<void> {
  // Replace whatever this identity published previously with the fresh
  // bundle generated this session (see LOCAL_*_PREKEY_ID above).
  const { error: deleteSignedError } = await supabase
    .from('signed_prekeys')
    .delete()
    .eq('owner_id', userId);
  if (deleteSignedError) throw deleteSignedError;

  const { error: deleteOneTimeError } = await supabase
    .from('one_time_prekeys')
    .delete()
    .eq('owner_id', userId);
  if (deleteOneTimeError) throw deleteOneTimeError;

  const { error: signedError } = await supabase.from('signed_prekeys').insert({
    owner_id: userId,
    signed_prekey_id: bundle.signedPrekeyId,
    public_key: bundle.signedPrekeyPublicBase64,
    signature: bundle.signedPrekeySignatureBase64,
    kyber_prekey_id: bundle.kyberPrekeyId,
    kyber_prekey_public_key: bundle.kyberPrekeyPublicBase64,
    kyber_prekey_signature: bundle.kyberPrekeySignatureBase64,
  });
  if (signedError) throw signedError;

  // The bundle's own one-time prekey, plus the pool — inserted together so
  // every peer claiming any of them (not just the first) can start a
  // session. See EXTRA_ONE_TIME_PREKEY_IDS above for why the pool exists.
  const oneTimeRows = [
    { owner_id: userId, prekey_id: bundle.oneTimePrekeyId, public_key: bundle.oneTimePrekeyPublicBase64 },
    ...extraOneTimePrekeys.map((p) => ({
      owner_id: userId,
      prekey_id: p.id,
      public_key: p.publicKeyBase64,
    })),
  ];
  const { error: oneTimeError } = await supabase.from('one_time_prekeys').insert(oneTimeRows);
  if (oneTimeError) throw oneTimeError;
}

export async function claimPeerPrekeyBundle(peerUserId: string): Promise<PreKeyBundleData> {
  const { data: identity, error: identityError } = await supabase
    .from('identities')
    .select('identity_public_key, registration_id')
    .eq('user_id', peerUserId)
    .single();
  if (identityError || !identity) {
    throw new Error(`Could not find identity for ${peerUserId}: ${identityError?.message ?? 'not found'}`);
  }

  const { data: signedPrekey, error: signedError } = await supabase
    .from('signed_prekeys')
    .select('signed_prekey_id, public_key, signature, kyber_prekey_id, kyber_prekey_public_key, kyber_prekey_signature')
    .eq('owner_id', peerUserId)
    .single();
  if (signedError || !signedPrekey) {
    throw new Error(`Peer ${peerUserId} has not published a signed prekey yet`);
  }

  const { data: oneTimePrekey, error: oneTimeError } = await supabase
    .from('one_time_prekeys')
    .select('id, prekey_id, public_key')
    .eq('owner_id', peerUserId)
    .limit(1)
    .single();
  if (oneTimeError || !oneTimePrekey) {
    throw new Error(`Peer ${peerUserId} has no available one-time prekey`);
  }

  // Claim = delete, so nobody else can reuse it — matches the "one-time
  // prekeys are deletable by anyone authenticated (claim = delete)" policy
  // in supabase/migrations/0001_init.sql.
  const { error: claimError } = await supabase
    .from('one_time_prekeys')
    .delete()
    .eq('id', oneTimePrekey.id);
  if (claimError) throw claimError;

  return {
    registrationId: identity.registration_id,
    deviceId: 1, // single device per identity for now
    identityKeyBase64: identity.identity_public_key,
    oneTimePrekeyId: oneTimePrekey.prekey_id,
    oneTimePrekeyPublicBase64: oneTimePrekey.public_key,
    signedPrekeyId: signedPrekey.signed_prekey_id,
    signedPrekeyPublicBase64: signedPrekey.public_key,
    signedPrekeySignatureBase64: signedPrekey.signature,
    kyberPrekeyId: signedPrekey.kyber_prekey_id,
    kyberPrekeyPublicBase64: signedPrekey.kyber_prekey_public_key,
    kyberPrekeySignatureBase64: signedPrekey.kyber_prekey_signature,
  };
}
