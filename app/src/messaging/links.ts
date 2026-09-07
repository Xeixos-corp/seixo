/**
 * Finds links in message text so they can be tapped.
 *
 * Note what this deliberately does not do: fetch anything. Rendering a link
 * preview -- the title and image other messengers show -- means the app
 * requesting that URL, which tells the site, and anyone watching the network,
 * that this link was shared and when. That is the app leaking the contents of
 * an encrypted message on the sender's behalf. Signal makes previews optional
 * and generates them only on the sending side for this exact reason; here
 * there are simply none.
 */

// Deliberately conservative. Trailing punctuation is excluded so that a link
// at the end of a sentence does not swallow the full stop, and only http and
// https are recognised -- other schemes (javascript:, file:, and anything a
// custom app registers) are left as plain text, since a tappable link is an
// invitation to trust it.
const LINK_PATTERN = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]}]|www\.[^\s<>"']+[^\s<>"'.,;:!?)\]}])/gi;

export type TextSegment = { text: string; url?: string };

export function splitLinks(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let lastIndex = 0;

  // Reset: the regex is module-level and stateful with the /g flag.
  LINK_PATTERN.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = LINK_PATTERN.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: text.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    segments.push({
      text: raw,
      // A bare www. address is shown exactly as typed but opened over https --
      // never http, which would silently downgrade to an unencrypted request.
      url: raw.toLowerCase().startsWith('www.') ? `https://${raw}` : raw,
    });
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < text.length) {
    segments.push({ text: text.slice(lastIndex) });
  }

  return segments.length > 0 ? segments : [{ text }];
}

export function hasLinks(text: string): boolean {
  LINK_PATTERN.lastIndex = 0;
  return LINK_PATTERN.test(text);
}
