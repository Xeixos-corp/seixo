import * as FileSystem from 'expo-file-system';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import SignalNativeExpoModule from '../../modules/signal-native-expo/src/SignalNativeExpoModule';
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from '../transport/supabaseClient';
import { useMessagesStore } from '../store/messagesStore';

/**
 * Images: choosing, preparing, sealing, moving and forgetting them.
 *
 * The shape of it, which docs/plans-deferred.md argues for at length: a photo
 * is re-encoded on the phone, sealed once under a key made for it
 * (packages/signal-native/rust/src/attachment.rs), and stored as an opaque
 * object named after its message. Only the key travels, inside each member's
 * ordinary encrypted envelope.
 *
 * The bytes never pass through JavaScript. React Native has no usable Blob,
 * and a photo routed through a base64 string costs a third more memory and
 * time for nothing. Everything below moves files: the native module seals and
 * opens them on disk, and expo-file-system streams them to and from storage.
 * JavaScript only ever holds paths and a key.
 */

/** Long enough to see clearly on a phone, which is where it will be seen. */
const MAX_SIDE = 1600;
const QUALITY = 0.7;
/** Drawn blurred, so it needs to carry colour and shape and nothing else. */
const PREVIEW_SIDE = 24;

const ROOT = `${FileSystem.cacheDirectory}seixo-attachments/`;
/** Must match the directory the native module writes into. */
const OPENED_DIR = `${ROOT}opened/`;

export const BUCKET = 'attachments';

/**
 * How long the server holds an image, at most, whatever the conversation's
 * timer. The same rule as voice: the server is a waiting room, not an archive.
 * The chosen lifetime travels inside the message and governs the phones; this
 * only decides when the server's copy may go. Kept at a day or less, so every
 * stored object dies within a day and a minute (migration 0027).
 */
export const IMAGE_SERVER_TTL_SECONDS = 24 * 60 * 60;

// ── Choosing ──────────────────────────────────────────────────────────────

export type PickResult =
  | { kind: 'picked'; uri: string; width: number; height: number }
  | { kind: 'cancelled' }
  | { kind: 'denied'; canAskAgain: boolean };

/**
 * Takes a photo, or lets the person choose one.
 *
 * The library needs no permission at all on iOS 14 and later: the picker runs
 * outside the app and hands back only the photo chosen, so Seixo never sees
 * the library. The camera does need permission, and the answer is passed up
 * rather than acted on here, so the screen can offer the way to Settings only
 * after a refusal that was not just given -- the same rule the microphone
 * follows.
 */
export async function pickImage(source: 'camera' | 'library'): Promise<PickResult> {
  const options: ImagePicker.ImagePickerOptions = {
    mediaTypes: ['images'],
    allowsEditing: false,
    // Full quality in; the re-encode below decides what goes out.
    quality: 1,
    // Asked not to, and re-encoded below regardless. This alone is not trusted.
    exif: false,
  };

  if (source === 'camera') {
    const before = await ImagePicker.getCameraPermissionsAsync();
    const permission = before.granted ? before : await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return { kind: 'denied', canAskAgain: before.canAskAgain };
    }
  }

  const result =
    source === 'camera'
      ? await ImagePicker.launchCameraAsync(options)
      : await ImagePicker.launchImageLibraryAsync(options);

  const asset = result.canceled ? undefined : result.assets?.[0];
  if (!asset) return { kind: 'cancelled' };
  return { kind: 'picked', uri: asset.uri, width: asset.width, height: asset.height };
}

// ── Preparing ─────────────────────────────────────────────────────────────

export type PreparedImage = {
  uri: string;
  width: number;
  height: number;
  previewBase64?: string;
};

/**
 * Decodes and re-encodes the photo, which is what removes its history.
 *
 * A JPEG straight off a camera carries EXIF: where it was taken to a few
 * metres, the camera and its serial, the exact second. In an app where nobody
 * gave their name, a photo of a cat could give away a home address. A
 * re-encode produces a new file from pixels alone.
 *
 * And then it is checked, because "the library strips it" is a claim about
 * someone else's code. If a location or camera block has survived, sending is
 * refused outright -- a refusal the person can see is better than a leak they
 * cannot.
 */
export async function prepareImage(picked: { uri: string; width: number; height: number }): Promise<PreparedImage> {
  const longest = Math.max(picked.width, picked.height);
  const resize =
    longest > MAX_SIDE
      ? [{ resize: picked.width >= picked.height ? { width: MAX_SIDE } : { height: MAX_SIDE } }]
      : [];

  let main: Awaited<ReturnType<typeof manipulateAsync>>;
  try {
    main = await manipulateAsync(picked.uri, resize, {
      compress: QUALITY,
      format: SaveFormat.JPEG,
    });
  } finally {
    // The picker leaves its copy of the original in the app's cache: full
    // size, EXIF and all, location included. It has served its purpose the
    // moment the re-encode exists, and must not sit on the phone afterwards.
    await FileSystem.deleteAsync(picked.uri, { idempotent: true });
  }

  try {
    await assertNoMetadata(main.uri);
  } catch (error) {
    await FileSystem.deleteAsync(main.uri, { idempotent: true });
    throw error;
  }

  const preview = await manipulateAsync(
    main.uri,
    [{ resize: main.width >= main.height ? { width: PREVIEW_SIDE } : { height: PREVIEW_SIDE } }],
    { compress: 0.4, format: SaveFormat.JPEG, base64: true },
  );
  await FileSystem.deleteAsync(preview.uri, { idempotent: true });

  return {
    uri: main.uri,
    width: main.width,
    height: main.height,
    previewBase64: preview.base64 ?? undefined,
  };
}

export class ImageMetadataError extends Error {
  constructor() {
    super('The image still carries metadata after re-encoding, and was not sent.');
    this.name = 'ImageMetadataError';
  }
}

/**
 * Reads the start of the file and refuses it if an EXIF or XMP block is
 * there. Both live in APP1 segments near the top of a JPEG, well within the
 * first 64 KB; the pixels come after.
 */
async function assertNoMetadata(uri: string): Promise<void> {
  const head = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length: 64 * 1024,
  });
  const bytes = base64ToBytes(head);
  const markers = [
    // "Exif\0\0" -- location, camera, time.
    [0x45, 0x78, 0x69, 0x66, 0x00, 0x00],
    // "http://ns.adobe.com/xap" -- XMP, which can carry the same things.
    [0x68, 0x74, 0x74, 0x70, 0x3a, 0x2f, 0x2f, 0x6e, 0x73, 0x2e, 0x61, 0x64, 0x6f, 0x62, 0x65],
  ];
  if (markers.some((marker) => indexOf(bytes, marker) !== -1)) {
    throw new ImageMetadataError();
  }
}

// ── Sending ───────────────────────────────────────────────────────────────

/** Seals the prepared image into a temporary file, ready to upload. */
export async function sealImage(uri: string) {
  return SignalNativeExpoModule.sealAttachmentFile(uri);
}

/**
 * Keeps the sender's own copy, as a file in the same place received pictures
 * go, so it is shown and cleaned up exactly like any other.
 */
export async function keepOwnCopy(uri: string): Promise<string> {
  await FileSystem.makeDirectoryAsync(OPENED_DIR, { intermediates: true });
  const fileName = `${randomName()}.jpg`;
  await FileSystem.moveAsync({ from: uri, to: OPENED_DIR + fileName });
  return fileName;
}

/**
 * Streams the sealed file to storage, named after its message.
 *
 * Must run after the message exists: the storage policy only accepts an
 * object whose message is already there, and only for two minutes after it
 * was created (migration 0027).
 *
 * `cache-control: no-store` matters more than it looks. The object must stop
 * existing when its message does; a copy sitting in a CDN or an HTTP cache
 * would quietly outlive it.
 */
export async function uploadSealed(messageId: string, sealedUri: string): Promise<void> {
  const token = await accessToken();
  try {
    const result = await FileSystem.uploadAsync(
      `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${messageId}`,
      sealedUri,
      {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY,
          'Content-Type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-upsert': 'false',
        },
      },
    );
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`upload refused (${result.status})`);
    }
  } finally {
    // Sealed, so nothing in it is readable -- but it has done its job and
    // there is no reason to keep it.
    await FileSystem.deleteAsync(sealedUri, { idempotent: true });
  }
}

// ── Receiving ─────────────────────────────────────────────────────────────

/**
 * Downloads and opens one picture, returning the name of the decrypted file.
 *
 * The download lands straight on disk and is opened there; the sealed copy is
 * deleted whether or not that worked.
 */
export async function fetchAndOpen(messageId: string, keyBase64: string): Promise<string> {
  const token = await accessToken();
  await FileSystem.makeDirectoryAsync(ROOT, { intermediates: true });
  const sealedPath = `${ROOT}download-${randomName()}.bin`;
  try {
    const response = await FileSystem.downloadAsync(
      `${SUPABASE_URL}/storage/v1/object/authenticated/${BUCKET}/${messageId}`,
      sealedPath,
      { headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY } },
    );
    if (response.status !== 200) {
      throw new Error(`download refused (${response.status})`);
    }
    const openedUri = await SignalNativeExpoModule.openAttachmentFile(sealedPath, keyBase64);
    return openedUri.substring(openedUri.lastIndexOf('/') + 1);
  } finally {
    await FileSystem.deleteAsync(sealedPath, { idempotent: true });
  }
}

/**
 * Waits for a picture that may not be there yet.
 *
 * The message reaches the other phone the instant it is inserted, and the
 * upload starts only after that -- so the first attempt can easily arrive
 * before the object exists. The policy allows two minutes for the upload;
 * this keeps trying for about as long, then gives up and says so.
 */
const RETRY_DELAYS_MS = [0, 2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
const inFlight = new Set<string>();

export function fetchImageInBackground(channelId: string, messageId: string, keyBase64: string): void {
  if (inFlight.has(messageId)) return;
  inFlight.add(messageId);

  void (async () => {
    const store = useMessagesStore.getState();
    try {
      for (const delay of RETRY_DELAYS_MS) {
        if (delay) await sleep(delay);
        // Gone while waiting -- expired, deleted, or the conversation left.
        if (!findMessage(channelId, messageId)) return;
        try {
          const fileName = await fetchAndOpen(messageId, keyBase64);
          // The key is dropped here: it opens nothing that still exists.
          store.updateMessageImage(channelId, messageId, {
            fileName,
            keyBase64: undefined,
            state: undefined,
          });
          return;
        } catch {
          // Most likely not uploaded yet. Try again after the next delay.
        }
      }
      store.updateMessageImage(channelId, messageId, { state: 'unavailable' });
    } finally {
      inFlight.delete(messageId);
    }
  })();
}

// ── Showing and forgetting ────────────────────────────────────────────────

export function imageUri(fileName: string): string {
  return OPENED_DIR + fileName;
}

/**
 * Deletes decrypted pictures as soon as nothing refers to them.
 *
 * Messages leave the store by many routes -- their timer, the person deleting
 * them, the other side deleting them, the conversation being left, expiry
 * while the app was closed. Chasing each route to delete a file would miss
 * one sooner or later. Watching the store instead catches all of them: any
 * file that was referenced and no longer is gets deleted.
 *
 * Also sweeps once at start, for anything a crash left behind.
 */
export function startImageJanitor(): () => void {
  let known: Set<string> | null = null;
  let unsubscribeStore: (() => void) | null = null;

  // Nothing may happen until the messages are loaded from disk. Before that
  // the store is empty, and a sweep would find every picture unreferenced and
  // delete all of them -- on every launch.
  const begin = () => {
    if (known) return;
    known = referencedFileNames();
    void sweep(known);
    resumePendingImages();

    unsubscribeStore = useMessagesStore.subscribe((state) => {
      const now = referencedFileNames(state.messagesByChannel);
      for (const name of known ?? []) {
        if (!now.has(name)) void FileSystem.deleteAsync(OPENED_DIR + name, { idempotent: true });
      }
      known = now;
    });
  };

  const unsubscribeHydration = useMessagesStore.persist.onFinishHydration(begin);
  if (useMessagesStore.persist.hasHydrated()) begin();

  return () => {
    unsubscribeHydration();
    unsubscribeStore?.();
  };
}

/**
 * Picks up pictures that were still being fetched when the app last closed.
 * Without this, a message received moments before the app was swiped away
 * would show its blurred preview for ever, holding a key it never used.
 */
function resumePendingImages(): void {
  const byChannel = useMessagesStore.getState().messagesByChannel;
  for (const [channelId, messages] of Object.entries(byChannel)) {
    for (const message of messages) {
      const image = message.image;
      if (image?.keyBase64 && !image.fileName && image.state !== 'unavailable') {
        fetchImageInBackground(channelId, message.id, image.keyBase64);
      }
    }
  }
}

async function sweep(referenced: Set<string>): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(ROOT);
    if (!info.exists) return;
    const opened = await FileSystem.readDirectoryAsync(OPENED_DIR).catch(() => [] as string[]);
    await Promise.all(
      opened
        .filter((name) => !referenced.has(name))
        .map((name) => FileSystem.deleteAsync(OPENED_DIR + name, { idempotent: true })),
    );
    // Sealed uploads and half-finished downloads are never worth keeping
    // across a launch.
    const top = await FileSystem.readDirectoryAsync(ROOT);
    await Promise.all(
      top
        .filter((name) => name.startsWith('download-'))
        .map((name) => FileSystem.deleteAsync(ROOT + name, { idempotent: true })),
    );
    await FileSystem.deleteAsync(`${ROOT}sealed/`, { idempotent: true });
  } catch (error) {
    console.warn('[attachments] sweep failed', error);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function referencedFileNames(
  byChannel = useMessagesStore.getState().messagesByChannel,
): Set<string> {
  const names = new Set<string>();
  for (const messages of Object.values(byChannel)) {
    for (const message of messages) {
      if (message.image?.fileName) names.add(message.image.fileName);
    }
  }
  return names;
}

function findMessage(channelId: string, messageId: string) {
  return useMessagesStore
    .getState()
    .messagesByChannel[channelId]?.find((message) => message.id === messageId);
}

async function accessToken(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('not signed in');
  return token;
}

function randomName(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function indexOf(haystack: Uint8Array, needle: number[]): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Small and dependency-free: used only on the first 64 KB of a file. */
function base64ToBytes(base64: string): Uint8Array {
  const clean = base64.replace(/[^A-Za-z0-9+/]/g, '');
  const bytes = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    buffer = ((buffer << 6) | BASE64_ALPHABET.indexOf(char)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[index++] = (buffer >> bits) & 0xff;
    }
  }
  return bytes.subarray(0, index);
}
