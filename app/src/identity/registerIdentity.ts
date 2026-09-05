import {
  initSignalDevice,
  generatePrekeyBundle,
  generateExtraOneTimePrekeys,
  identityPublicKeyBase64,
} from '../crypto';
import {
  signInAnonymouslyIfNeeded,
  upsertMyIdentity,
  publishPrekeyBundle,
  countMyOneTimePrekeys,
  insertOneTimePrekeys,
  LOCAL_ONE_TIME_PREKEY_ID,
  LOCAL_SIGNED_PREKEY_ID,
  LOCAL_KYBER_PREKEY_ID,
  EXTRA_ONE_TIME_PREKEY_IDS,
} from '../transport/identities';
import { subscribeToMyNewMemberships, getOtherMember } from '../transport/channels';
import { fetchBlockedPeerIds } from '../transport/blocking';
import { useConversationsStore, DEFAULT_TTL_SECONDS } from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { loadPrekeyAllocation, savePrekeyAllocation } from './prekeyState';

// Replenish once the published pool drops to this, in batches of this size.
// Small enough that a peer is unlikely to find the pool empty, large enough
// not to hit the server on every launch.
const REPLENISH_BELOW = 5;
const REPLENISH_BATCH = 20;

/**
 * Tops up the published one-time prekeys when they run low, always with ids
 * that have never been used before.
 *
 * Never regenerates an existing id: a peer may already hold the public half
 * of one and not have sent with it yet, and replacing the private key would
 * make that message permanently undecryptable.
 *
 * Deliberately non-fatal. This runs after the identity is otherwise usable,
 * and a failure here (offline, say) must not fail registration -- doRegister
 * failing clears the memo and the whole app retries, which is a far worse
 * outcome than a pool that gets topped up on the next launch instead.
 */
async function replenishOneTimePrekeysIfLow(userId: string, nextId: number): Promise<void> {
  try {
    const remaining = await countMyOneTimePrekeys(userId);
    if (remaining > REPLENISH_BELOW) return;

    const ids = Array.from({ length: REPLENISH_BATCH }, (_, i) => nextId + i);
    const prekeys = generateExtraOneTimePrekeys(ids);
    await insertOneTimePrekeys(userId, prekeys);
    await savePrekeyAllocation({ userId, nextId: nextId + REPLENISH_BATCH });
  } catch (error) {
    console.error('[registerIdentity] could not replenish one-time prekeys', error);
  }
}

export type RegisteredIdentity = {
  userId: string;
  identityPublicKeyBase64: string;
};

// Memoized so registerIdentity() is safe to call from multiple places
// (App.tsx on launch, OnboardingScreen on button press) without generating
// a second identity or re-publishing twice concurrently. A failure clears
// the memo so the next call retries instead of replaying a stale rejection.
let registerPromise: Promise<RegisteredIdentity> | null = null;

export function registerIdentity(): Promise<RegisteredIdentity> {
  if (!registerPromise) {
    registerPromise = doRegister().catch((error) => {
      registerPromise = null;
      throw error;
    });
  }
  return registerPromise;
}

/**
 * Clears the memoized registration so the next registerIdentity() call
 * actually re-registers instead of returning the old (now-deleted)
 * identity. Used by identity/deleteAccount.ts after wiping local state.
 */
export function resetRegisteredIdentity(): void {
  registerPromise = null;
}

async function doRegister(): Promise<RegisteredIdentity> {
  const userId = await signInAnonymouslyIfNeeded();
  await initSignalDevice(userId, 1);

  // Publishing is a first-run action, not a per-launch one.
  //
  // This used to regenerate ids 1..20 and republish on *every* launch, which
  // silently destroyed messages: a peer claims the public half of one-time
  // prekey N and sends; before that message is decrypted (which only happens
  // when its conversation is opened) this device restarts, regenerates N with
  // a different key, and the private half that would have opened it is gone.
  // The message can never be read -- and nothing reports it, because from the
  // outside it just looks like a message that failed to decrypt.
  //
  // The signed and Kyber prekeys had the same problem: same fixed ids,
  // regenerated each launch. Not rotating them is a known gap (see
  // docs/threat-model.md); rotating them in a way that breaks sessions
  // already in flight was worse than not rotating at all.
  const allocation = await loadPrekeyAllocation(userId);

  if (!allocation) {
    const bundle = generatePrekeyBundle(
      LOCAL_ONE_TIME_PREKEY_ID,
      LOCAL_SIGNED_PREKEY_ID,
      LOCAL_KYBER_PREKEY_ID,
    );
    const extraOneTimePrekeys = generateExtraOneTimePrekeys(EXTRA_ONE_TIME_PREKEY_IDS);

    await upsertMyIdentity(userId, bundle.identityKeyBase64, bundle.registrationId);
    await publishPrekeyBundle(userId, bundle, extraOneTimePrekeys);
    await savePrekeyAllocation({
      userId,
      nextId: Math.max(LOCAL_ONE_TIME_PREKEY_ID, ...EXTRA_ONE_TIME_PREKEY_IDS) + 1,
    });

    await finishRegistration(userId);
    return { userId, identityPublicKeyBase64: bundle.identityKeyBase64 };
  }

  // Already published for this identity: leave every existing key alone and
  // just top the pool up if peers have been claiming from it.
  await replenishOneTimePrekeysIfLow(userId, allocation.nextId);

  const publicKey = identityPublicKeyBase64();
  await finishRegistration(userId);
  return { userId, identityPublicKeyBase64: publicKey };
}

/** The parts of registration that run whether or not keys were just published. */
async function finishRegistration(userId: string): Promise<void> {

  const blockedPeerIds = await fetchBlockedPeerIds(userId);
  useBlockedPeersStore.getState().setBlockedPeerIds(blockedPeerIds);

  // Detect conversations other people start with us (the receiving side of
  // createDirectChannel — see app/src/transport/channels.ts).
  subscribeToMyNewMemberships(userId, async (channelId) => {
    try {
      const peerUserId = await getOtherMember(channelId, userId);
      useConversationsStore
        .getState()
        .addConversation({ channelId, peerUserId, ttlSeconds: DEFAULT_TTL_SECONDS });
    } catch (error) {
      console.error('[registerIdentity] failed to resolve new channel membership', error);
    }
  });
}
