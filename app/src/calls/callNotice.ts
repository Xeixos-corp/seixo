import type { TFunction } from 'i18next';
import type { StoredCall } from '../store/messagesStore';
import { formatCallDuration } from '../components/CallOverlay';

/**
 * The line a call leaves in its conversation, e.g. "Chamada de voz · 3:12" or
 * "Chamada perdida". Shared by the conversation and the list's preview.
 */
export function callNoticeText(t: TFunction, outgoing: boolean, call: StoredCall): string {
  const direction = outgoing ? 'outgoing' : 'incoming';
  if (call.outcome === 'answered') {
    return t(`call.log.${direction}Answered`, { duration: formatCallDuration(call.durationSeconds ?? 0) });
  }
  return t(`call.log.${direction}.${call.outcome}`);
}
