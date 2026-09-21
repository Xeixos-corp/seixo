import { create } from 'zustand';
import * as FileSystem from 'expo-file-system';

/** A photo shared from another app: the share extension's copy of it, untouched. */
export type SharedImage = { uri: string; width: number; height: number };

type PendingShareState = {
  /** Text or link shared into Seixo from another app, not yet placed anywhere. */
  text: string | null;
  /** A photo shared into Seixo from another app, not yet placed anywhere. */
  image: SharedImage | null;
  setText: (text: string) => void;
  setImage: (image: SharedImage) => void;
  /**
   * Hands the photo over to whoever will place it, and forgets it here
   * without deleting it: from now on the file is theirs to delete.
   */
  takeImage: () => SharedImage | null;
  clear: () => void;
};

/**
 * Holds something shared from the iOS share sheet between the moment it
 * arrives and the moment the person chooses a conversation for it.
 *
 * Deliberately not persisted. A shared link is the person's to place, and
 * keeping it on disk would leave it behind after they changed their mind --
 * in an app whose whole premise is that things do not linger.
 *
 * A photo is the exception that cannot help touching disk: the extension
 * hands it over as a file. That file is the original, location and all, so
 * every way of letting go of it here deletes it.
 */
export const usePendingShareStore = create<PendingShareState>()((set, get) => ({
  text: null,
  image: null,
  setText: (text) => {
    discardSharedImage(get().image);
    set({ text, image: null });
  },
  setImage: (image) => {
    if (get().image?.uri !== image.uri) discardSharedImage(get().image);
    set({ image, text: null });
  },
  takeImage: () => {
    const image = get().image;
    set({ image: null });
    return image;
  },
  clear: () => {
    discardSharedImage(get().image);
    set({ text: null, image: null });
  },
}));

/** Deletes the extension's copy of a shared photo. Safe to call twice. */
export function discardSharedImage(image: SharedImage | null): void {
  if (!image) return;
  FileSystem.deleteAsync(image.uri, { idempotent: true }).catch((error) =>
    console.warn('[share] could not delete a shared photo', error),
  );
}
