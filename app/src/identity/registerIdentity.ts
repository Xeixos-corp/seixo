import { initSignalDevice, generatePrekeyBundle, generateExtraOneTimePrekeys } from '../crypto';
import {
  signInAnonymouslyIfNeeded,
  upsertMyIdentity,
  publishPrekeyBundle,
  LOCAL_ONE_TIME_PREKEY_ID,
  LOCAL_SIGNED_PREKEY_ID,
  LOCAL_KYBER_PREKEY_ID,
  EXTRA_ONE_TIME_PREKEY_IDS,
} from '../transport/identities';
import { subscribeToMyNewMemberships, getOtherMember } from '../transport/channels';
import { useConversationsStore, DEFAULT_TTL_SECONDS } from '../store/conversationsStore';

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

async function doRegister(): Promise<RegisteredIdentity> {
  const userId = await signInAnonymouslyIfNeeded();
  await initSignalDevice(userId, 1);

  const bundle = generatePrekeyBundle(
    LOCAL_ONE_TIME_PREKEY_ID,
    LOCAL_SIGNED_PREKEY_ID,
    LOCAL_KYBER_PREKEY_ID,
  );
  const extraOneTimePrekeys = generateExtraOneTimePrekeys(EXTRA_ONE_TIME_PREKEY_IDS);

  await upsertMyIdentity(userId, bundle.identityKeyBase64, bundle.registrationId);
  await publishPrekeyBundle(userId, bundle, extraOneTimePrekeys);

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

  return { userId, identityPublicKeyBase64: bundle.identityKeyBase64 };
}
