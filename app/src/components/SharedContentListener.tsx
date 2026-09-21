import { useEffect } from 'react';
import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system';
import Constants from 'expo-constants';
import { useShareIntentContext } from 'expo-share-intent';
import { usePendingShareStore } from '../store/pendingShareStore';
import { clearSharedFiles } from '../../modules/shared-badge-expo/src';

const APP_GROUP: string | undefined = Constants.expoConfig?.extra?.appGroup;

/**
 * A shared photo left in the App Group this long is an orphan: the app was
 * closed or crashed before it was sent or discarded. Long enough that a share
 * arriving as the app opens is never mistaken for one.
 */
const ORPHAN_AFTER_SECONDS = 10 * 60;

/**
 * Far longer than any link, short enough that pasting a book into the share
 * sheet cannot produce a draft the composer struggles with.
 */
const MAX_SHARED_LENGTH = 4000;

/**
 * Takes whatever arrived through the iOS share sheet and parks it for the
 * person to place.
 *
 * It only ever parks. Nothing is sent: the conversation list offers a choice
 * of conversation, the text lands in that conversation's input box, and it
 * leaves only when the person presses send -- encrypted by the app like any
 * other message. The share extension itself never touches keys; it only hands
 * the item over.
 *
 * Copied out of the library straight away and the library's copy cleared, so
 * the item survives the app briefly going to the background while the
 * conversation is being chosen (the library resets on background by default).
 *
 * A photo arrives as a file the extension copied into the App Group: the
 * original, with its location still in it. Only its path is parked here; the
 * file is deleted as soon as it is sent (the re-encode deletes its source) or
 * let go of in any other way. Anything shared that is not a photo is deleted
 * on arrival -- the extension accepts only photos, but a file it copied is
 * never left behind on the strength of that.
 */
export function SharedContentListener(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const setText = usePendingShareStore((state) => state.setText);
  const setImage = usePendingShareStore((state) => state.setImage);

  useEffect(() => {
    void clearSharedFiles(APP_GROUP, ORPHAN_AFTER_SECONDS);
  }, []);

  useEffect(() => {
    if (!hasShareIntent) return;

    const files = (shareIntent.files ?? []).filter((file) => Boolean(file.path));
    const photo = files.find((file) => file.mimeType?.startsWith('image/'));
    for (const file of files) {
      if (file !== photo) void FileSystem.deleteAsync(file.path, { idempotent: true }).catch(() => undefined);
    }

    if (photo) {
      void withSize(photo.path, photo.width, photo.height).then(
        (size) => setImage({ uri: photo.path, ...size }),
        (error) => {
          console.warn('[share] could not read the shared photo', error);
          void FileSystem.deleteAsync(photo.path, { idempotent: true }).catch(() => undefined);
        },
      );
    } else {
      const shared = (shareIntent.text ?? shareIntent.webUrl ?? '').trim().slice(0, MAX_SHARED_LENGTH);
      if (shared) setText(shared);
    }
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, setText, setImage]);

  return null;
}

/**
 * The extension usually reports the size, already turned for the photo's
 * orientation. When it could not, it is read from the file -- the size decides
 * which side the re-encode shrinks.
 */
function withSize(uri: string, width: number | null, height: number | null): Promise<{ width: number; height: number }> {
  if (width && height) return Promise.resolve({ width, height });
  return new Promise((resolve, reject) => {
    Image.getSize(uri, (w, h) => resolve({ width: w, height: h }), reject);
  });
}
