import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as FileSystem from 'expo-file-system';
import * as Notifications from 'expo-notifications';
import SignalNativeExpoModule from '../../modules/signal-native-expo/src/SignalNativeExpoModule';
import { clearSharedFiles, setBadgeCount } from '../../modules/shared-badge-expo/src';
import { supabase } from '../transport/supabaseClient';
import { wipeLocalSignalStore } from '../crypto';
import { clearMasterKeyBase64 } from '../crypto/masterKey';
import { resetRegisteredIdentity } from '../identity/registerIdentity';
import { clearPrekeyAllocation } from '../identity/prekeyState';
import { getCurrentUserId, setCurrentUserId } from '../identity/currentUser';
import { resetPushRegistration } from '../notifications/usePushRegistration';
import { deletePushToken } from '../notifications/pushTokens';
import { clearFailedMessageCache } from '../messaging/ingest';
import { setActiveConversation } from '../messaging/activeConversation';
import { clearCodes } from './lockCode';
import { useAppLockStore } from '../store/appLockStore';
import { useBackupPromptStore } from '../store/backupPromptStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { useConversationsStore } from '../store/conversationsStore';
import { useMessagesStore } from '../store/messagesStore';
import { useNotificationSoundStore } from '../store/notificationSoundStore';
import { usePendingShareStore } from '../store/pendingShareStore';
import { usePrivacyPreferencesStore } from '../store/privacyPreferencesStore';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import { useTermsStore } from '../store/termsStore';
import { useThemeStore } from '../store/themeStore';

const APP_GROUP: string | undefined = Constants.expoConfig?.extra?.appGroup;

/** How long the server is given to forget the push token before the wipe carries on without it. */
const SERVER_GRACE_MS = 1500;

/**
 * What the panic code does: leaves this phone looking like Seixo was just
 * installed, and nothing else.
 *
 * Everything local goes -- messages, conversations, keys, the Signal store,
 * pictures, recordings, settings, the codes themselves -- and the app is left
 * at the welcome screen a fresh install shows. Nobody looking at it can tell
 * what was there, and nothing on it can be recovered.
 *
 * The account on the server is deliberately left alone. Deleting it would
 * need the network, which may not be there, and would take the way back with
 * it: someone who made a recovery backup can restore the same account later,
 * on this phone or another, and carry on with the same contacts. Without a
 * backup, the account is simply abandoned and the server removes it in time
 * like any other (migration 0016).
 *
 * Two things would give the game away afterwards, and both are dealt with
 * before anything is erased: the phone would keep receiving "you have a new
 * message" for an account that no longer seems to exist, so the push token is
 * withdrawn on the server (if it answers quickly) and, whatever happens, on
 * the phone itself, where no network is needed; and notifications already on
 * the lock screen are removed.
 *
 * Every step is attempted regardless of the others. A step that fails must
 * not leave the rest undone -- half a wipe is the worst outcome there is.
 */
export async function panicWipe(): Promise<void> {
  const userId = getCurrentUserId();

  await attempt('push token (server)', () =>
    userId ? withTimeout(deletePushToken(userId), SERVER_GRACE_MS) : Promise.resolve(),
  );
  await attempt('push token (phone)', () => Notifications.unregisterForNotificationsAsync());
  await attempt('delivered notifications', () => Notifications.dismissAllNotificationsAsync());
  await attempt('badge', () => setBadgeCount(0, APP_GROUP));

  // Local only: no request to the server, which may be unreachable, and no
  // revoking of the session there -- the account is being kept, not closed.
  await attempt('session', () => supabase.auth.signOut({ scope: 'local' }).then(() => undefined));

  await attempt('signal store', async () => wipeLocalSignalStore());
  await attempt('master key', () => clearMasterKeyBase64());
  await attempt('lock codes', () => clearCodes());
  await attempt('prekey allocation', () => clearPrekeyAllocation());

  resetRegisteredIdentity();
  clearFailedMessageCache();
  resetPushRegistration();
  setActiveConversation(null);
  setCurrentUserId(null);

  // Every store back to what a fresh install starts with. Each is reset in
  // memory -- the app keeps running -- and then storage is emptied below, so
  // nothing written before this survives on disk either.
  for (const store of [
    useMessagesStore,
    useConversationsStore,
    useBlockedPeersStore,
    useSecurityWarningsStore,
    usePendingShareStore,
    useBackupPromptStore,
    useNotificationSoundStore,
    usePrivacyPreferencesStore,
    useThemeStore,
    useTermsStore,
  ] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reset = store as unknown as { setState: (s: any, replace: true) => void; getInitialState: () => any };
    await attempt('store', async () => reset.setState(reset.getInitialState(), true));
  }
  await attempt('app lock', async () =>
    useAppLockStore.setState({ enabled: false, method: 'device', unlocked: true }),
  );
  await attempt('storage', () => AsyncStorage.clear());

  // Files: decrypted pictures, recordings, backups written for sharing --
  // all of it lives in the cache directory -- and anything the share
  // extension left in the App Group.
  await attempt('opened pictures', async () => SignalNativeExpoModule.clearAttachmentFiles());
  await attempt('cache', () => emptyDirectory(FileSystem.cacheDirectory));
  await attempt('shared files', () => clearSharedFiles(APP_GROUP, 0));
}

async function attempt(label: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (error) {
    // The label only: an error here could name a file or an id, and this runs
    // precisely when someone may be reading over the person's shoulder.
    console.warn(`[panic] step failed: ${label}`, error instanceof Error ? error.name : 'error');
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))]);
}

async function emptyDirectory(directory: string | null): Promise<void> {
  if (!directory) return;
  const entries = await FileSystem.readDirectoryAsync(directory);
  await Promise.all(
    entries.map((entry) =>
      FileSystem.deleteAsync(`${directory}${entry}`, { idempotent: true }).catch(() => undefined),
    ),
  );
}
