import * as FileSystem from 'expo-file-system';

/**
 * Where decrypted audio is written so it can be played.
 *
 * Playing a recording requires a file on disk, which means the audio exists
 * decrypted outside the encrypted store for as long as that file does. Left
 * alone, those files would outlive the messages they came from -- the message
 * disappears on its timer and the audio stays in the app's cache, which is
 * exactly the kind of quiet exception this app should not have.
 *
 * Two rules keep that from happening: every file is deleted as soon as
 * playback ends, and the whole directory is emptied at launch, which cleans
 * up after a crash or a force-quit that skipped the first rule.
 */
const VOICE_DIR = `${FileSystem.cacheDirectory}seixo-voice/`;

async function ensureDirectory(): Promise<void> {
  const info = await FileSystem.getInfoAsync(VOICE_DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(VOICE_DIR, { intermediates: true });
  }
}

/** Writes audio out for playback. The caller must call discard() afterwards. */
export async function materialiseForPlayback(
  messageId: string,
  base64: string,
): Promise<string> {
  await ensureDirectory();
  const uri = `${VOICE_DIR}${messageId}.m4a`;
  await FileSystem.writeAsStringAsync(uri, base64, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return uri;
}

export async function discard(uri: string): Promise<void> {
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch (error) {
    console.warn('[voice] failed to delete temporary audio', error);
  }
}

/**
 * Empties the directory. Called at launch, because a crash mid-playback would
 * otherwise leave decrypted audio behind indefinitely.
 */
export async function clearVoiceCache(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(VOICE_DIR);
    if (info.exists) {
      await FileSystem.deleteAsync(VOICE_DIR, { idempotent: true });
    }
  } catch (error) {
    console.warn('[voice] failed to clear voice cache', error);
  }
}

/** Reads a finished recording so it can be encrypted, then removes it. */
export async function readRecordingAndDelete(uri: string): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  await discard(uri);
  return base64;
}
