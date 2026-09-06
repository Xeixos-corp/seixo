/**
 * What actually travels inside an encrypted message.
 *
 * Until replies existed, the ciphertext contained exactly the message text and
 * nothing else. Replies need one more field -- which message is being answered
 * -- and that field has to live *inside* the encryption. Putting it in a
 * database column would tell the server which messages are related, which is a
 * conversation graph it currently cannot see and has no business seeing.
 *
 * Backwards and forwards compatibility, both of which matter here because two
 * phones are rarely updated at the same moment:
 *
 * - A message with no reply is still sent as bare text, byte for byte as
 *   before. An older build reads it exactly as it always did.
 * - A reply is sent as JSON carrying a marker. Decoding anything that is not
 *   marked JSON falls back to treating the whole string as text, so an older
 *   build's plain message is read correctly by a newer one.
 *
 * The one gap, stated plainly: an older build receiving a *reply* shows the
 * raw JSON, because it has no idea this format exists. There is no way around
 * that without having shipped the decoder first. It resolves as soon as both
 * devices are on this version.
 *
 * Note what a reply does NOT carry: the quoted text. Only the id. Copying the
 * quoted text would mean a fragment of a message that has since expired living
 * on inside a newer one, under a different timer -- an exception to the
 * disappearing-message promise that the person who sent it would never know
 * about. The quote is looked up locally instead, and shows as unavailable when
 * the original is genuinely gone. See docs/threat-model.md.
 */

const MARKER = 'seixo.msg.v1';

type EncodedReply = {
  /** Marker, so a plain text message that happens to be valid JSON is not misread. */
  k: typeof MARKER;
  /** The message text. */
  t: string;
  /** Id of the message being replied to. */
  r: string;
};

export type MessagePayload = {
  text: string;
  replyToId?: string;
};

export function encodePayload(payload: MessagePayload): string {
  if (!payload.replyToId) {
    // Unchanged wire format for the overwhelmingly common case.
    return payload.text;
  }
  const encoded: EncodedReply = { k: MARKER, t: payload.text, r: payload.replyToId };
  return JSON.stringify(encoded);
}

export function decodePayload(raw: string): MessagePayload {
  // Cheap guard before attempting a parse: the vast majority of messages are
  // plain text and would only make JSON.parse throw.
  if (!raw.startsWith('{')) return { text: raw };

  try {
    const parsed = JSON.parse(raw) as Partial<EncodedReply>;
    if (parsed?.k !== MARKER || typeof parsed.t !== 'string' || typeof parsed.r !== 'string') {
      return { text: raw };
    }
    return { text: parsed.t, replyToId: parsed.r };
  } catch {
    // Genuinely just a message that starts with a brace.
    return { text: raw };
  }
}
