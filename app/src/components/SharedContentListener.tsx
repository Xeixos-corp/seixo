import { useEffect } from 'react';
import { useShareIntentContext } from 'expo-share-intent';
import { usePendingShareStore } from '../store/pendingShareStore';

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
 * the text over.
 *
 * Copied out of the library straight away and the library's copy cleared, so
 * the text survives the app briefly going to the background while the
 * conversation is being chosen (the library resets on background by default).
 */
export function SharedContentListener(): null {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntentContext();
  const setText = usePendingShareStore((state) => state.setText);

  useEffect(() => {
    if (!hasShareIntent) return;
    const shared = (shareIntent.text ?? shareIntent.webUrl ?? '').trim().slice(0, MAX_SHARED_LENGTH);
    if (shared) setText(shared);
    resetShareIntent();
  }, [hasShareIntent, shareIntent, resetShareIntent, setText]);

  return null;
}
