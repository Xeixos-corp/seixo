import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import * as DocumentPicker from 'expo-document-picker';

import {
  createRecoveryBackup as sealBackup,
  readRecoveryBackup,
  restoreIdentityFromBackup,
  generateRecoveryPhrase,
  deriveBackupCredentials,
  initSignalDevice,
  generatePrekeyBundle,
  generateExtraOneTimePrekeys,
  wipeLocalSignalStore,
  type RecoveryBackupContents,
} from '../crypto';
import { supabase } from '../transport/supabaseClient';
import {
  upsertMyIdentity,
  publishPrekeyBundle,
  LOCAL_ONE_TIME_PREKEY_ID,
  LOCAL_SIGNED_PREKEY_ID,
  LOCAL_KYBER_PREKEY_ID,
  EXTRA_ONE_TIME_PREKEY_IDS,
} from '../transport/identities';
import { savePrekeyAllocation, clearPrekeyAllocation } from '../identity/prekeyState';
import { resetRegisteredIdentity } from '../identity/registerIdentity';
import { setCurrentUserId } from '../identity/currentUser';

/**
 * Device migration: getting your account back on a new phone, from a file you
 * keep yourself.
 *
 * The backup holds an identity, not a history. Messages are not in it, and
 * neither is session state -- see packages/signal-native/rust/src/backup.rs
 * for why restoring ratchet state is the one thing this must never do. What
 * survives is who you are: the same user id, so contacts keep writing to an
 * account you can read, and the same identity key, so a safety number anyone
 * verified stays verified.
 *
 * Nothing is stored on our server. The file lives wherever the user puts it,
 * which is the point: a copy kept for every user would be the only thing in
 * this app that never expires, and the one target worth attacking.
 */

const BACKUP_VERSION = 1;

export type CreatedBackup = {
  phrase: string;
  fileUri: string;
  fileName: string;
};

/**
 * Thrown when the phrase and file were both good but the account behind them
 * is gone -- almost always the six-month abandoned-account purge
 * (supabase/migrations/0016_purge_abandoned_accounts.sql).
 *
 * The deduction is safe because of the order things happen in: the file is
 * opened with the phrase *before* the sign-in is attempted, so reaching a
 * failed sign-in means the phrase was right. There is nothing left for it to
 * be except an account that no longer exists.
 */
export class AccountGoneError extends Error {
  constructor() {
    super('The account this backup belongs to no longer exists.');
    this.name = 'AccountGoneError';
  }
}

/**
 * Thrown when the account could not be given the credentials a restore will
 * need. Distinguished from every other failure because the fix is a server
 * setting, not something the user did.
 */
export class BackupCredentialsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCredentialsError';
  }
}

/**
 * Makes a recovery file for the current identity, and returns the phrase that
 * opens it.
 *
 * The order here is deliberate. The account credentials are attached and
 * *verified* first, and only then is the file written -- so a backup that
 * exists is a backup that will work. The alternative, writing the file first
 * and hoping, produces something that looks like a safety net and turns out
 * not to be one at the exact moment it is needed.
 */
export async function createBackup(): Promise<CreatedBackup> {
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user?.id;
  if (!userId) throw new Error('No identity on this device to back up.');

  const phrase = generateRecoveryPhrase();
  const credentials = deriveBackupCredentials(phrase);

  // Attaching a derived credential pair to the anonymous account is what
  // makes it re-enterable later. It is not a login the user ever types: the
  // address is on a reserved domain that cannot receive mail, and both halves
  // come from the phrase, so nothing about the user is revealed and nothing
  // needs storing.
  const { data: updated, error } = await supabase.auth.updateUser({
    email: credentials.email,
    password: credentials.password,
  });
  if (error) {
    throw new BackupCredentialsError(error.message);
  }
  // A project that requires email confirmation would leave the address
  // pending instead of applying it, and the restore would then fail on a
  // phone that no longer has the identity. Better to refuse now, loudly.
  if (updated?.user?.email !== credentials.email) {
    throw new BackupCredentialsError(
      'The account did not accept its recovery credentials, so this backup would not restore.',
    );
  }

  // Kept short on purpose. Every field here is a field that outlives the
  // disappearing timers, in a file we no longer control once it leaves.
  const blob = sealBackup(phrase, {
    version: BACKUP_VERSION,
    userId,
    createdAt: new Date().toISOString(),
  });

  const fileName = `seixo-${new Date().toISOString().slice(0, 10)}.seixobak`;
  // The cache directory, not documents: this copy is a handoff to the share
  // sheet, and the user's real copy is wherever they choose to put it. Left
  // in cache, iOS reclaims it on its own rather than us keeping a second
  // copy of the most sensitive file in the app forever.
  const fileUri = `${FileSystem.cacheDirectory}${fileName}`;
  await FileSystem.writeAsStringAsync(fileUri, blob);

  return { phrase, fileUri, fileName };
}

/** Hands the file to the system share sheet, so the user picks where it goes. */
export async function shareBackup(fileUri: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device.');
  }
  await Sharing.shareAsync(fileUri, {
    mimeType: 'application/octet-stream',
    dialogTitle: 'Seixo',
  });
}

/** Lets the user pick a backup file; null if they backed out. */
export async function pickBackupFile(): Promise<string | null> {
  const result = await DocumentPicker.getDocumentAsync({
    // Deliberately not filtered by extension: iOS hides files it does not
    // recognise the type of, and a backup the user cannot see is a backup
    // they cannot restore.
    type: '*/*',
    copyToCacheDirectory: true,
  });
  if (result.canceled || !result.assets?.[0]) return null;
  return result.assets[0].uri;
}

/**
 * Restores an identity from a backup file onto this device.
 *
 * Refuses if this device already has an identity. A restore is not a merge --
 * it would replace the identity while leaving the sessions built on it in
 * place, and the resulting failures would surface much later than their
 * cause. Delete the account first, deliberately, or restore on a fresh
 * install.
 */
export async function restoreBackup(phrase: string, fileUri: string): Promise<string> {
  const { data: existing } = await supabase.auth.getSession();
  if (existing.session?.user) {
    throw new Error('This device already has an identity. Delete it first to restore a backup.');
  }

  const blob = await FileSystem.readAsStringAsync(fileUri);
  const contents: RecoveryBackupContents = readRecoveryBackup(phrase, blob);
  if (contents.version !== BACKUP_VERSION) {
    throw new Error('This backup was made by a newer version of Seixo.');
  }

  const credentials = deriveBackupCredentials(phrase);
  const { data: signedIn, error } = await supabase.auth.signInWithPassword({
    email: credentials.email,
    password: credentials.password,
  });
  // The file already opened, so the phrase is right (see AccountGoneError).
  // Reporting "invalid login credentials" here would send someone hunting for
  // a typo that isn't there.
  if (error) throw new AccountGoneError();

  const userId = signedIn.user?.id;
  // The file and the account must describe the same person. If they do not,
  // something is wrong in a way that continuing would only make worse.
  if (!userId || userId !== contents.userId) {
    await supabase.auth.signOut();
    throw new Error('This backup does not match the account it opened.');
  }

  // Clear whatever a partly-completed earlier attempt may have left, so the
  // native side accepts the identity rather than refusing as "already
  // present" and stranding the user with no way forward.
  wipeLocalSignalStore();
  await clearPrekeyAllocation();

  await restoreIdentityFromBackup(contents.identityKeyPairBase64, contents.registrationId);
  await initSignalDevice(userId, 1);
  setCurrentUserId(userId);
  resetRegisteredIdentity();

  // The prekeys published under this identity are unusable now: their private
  // halves went with the old phone. Republishing is not optional -- without
  // it, every contact would fetch a bundle whose keys nobody can answer.
  //
  // Messages already encrypted to those old keys are lost, and there is no
  // arrangement that saves them: they were sealed to a secret that no longer
  // exists anywhere. Republishing does not destroy anything that was still
  // readable.
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
    signedPrekeys: [
      {
        signedId: LOCAL_SIGNED_PREKEY_ID,
        kyberId: LOCAL_KYBER_PREKEY_ID,
        createdAt: new Date().toISOString(),
      },
    ],
    nextSignedId: Math.max(LOCAL_SIGNED_PREKEY_ID, LOCAL_KYBER_PREKEY_ID) + 1,
  });

  return userId;
}
