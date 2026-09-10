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

type Encoded = {
  /** Marker, so a plain text message that happens to be valid JSON is not misread. */
  k: typeof MARKER;
  /** The message text. */
  t: string;
  /** Id of the message being replied to. */
  r?: string;
  /**
   * Id of a message this one replaces.
   *
   * An edit has to travel as a new message. The ciphertext already on the
   * server cannot simply be rewritten: each message is encrypted with a key
   * used once and then destroyed, so the recipient either already spent that
   * key reading the original -- and could never read a replacement -- or has
   * not read it yet and would find a message encrypted with a key that no
   * longer fits anything. The Double Ratchet makes editing in place
   * impossible, not merely awkward.
   */
  e?: string;
  /**
   * A reaction: the id of the message being reacted to. `t` carries the emoji,
   * or an empty string to take the reaction back.
   *
   * Reactions ride the same encrypted path as everything else -- there is no
   * other way to reach the other device -- but they are marked `silent` on the
   * wire so they do not fire a push notification each
   * (supabase/migrations/0015_silent_messages.sql).
   */
  x?: string;
  /** Voice message: the recording, base64. */
  a?: string;
  /** Voice message: duration in milliseconds, so it can be shown before playing. */
  d?: number;
  /**
   * How long this message should live on the *devices*, in seconds.
   *
   * Separate from the row's `expires_at`, which is only how long the server
   * holds it waiting for delivery. Voice messages are capped to 24 hours on
   * the server no matter what the sender chose, because audio is large and
   * the server is a waiting room, not an archive -- but the message should
   * still live for as long as the sender asked once it has arrived. Sending
   * that inside the encryption keeps the real lifetime out of the server's
   * view: it only ever learns when it may throw its copy away.
   */
  l?: number;
  /**
   * Padding. Voice recordings are encoded at a constant bitrate, so the size
   * of the ciphertext would otherwise be the duration of the recording --
   * telling the server "these two exchanged 47 seconds of speech at 21:14".
   * Rounding the payload up to a fixed bucket reduces that to a range.
   *
   * Never read. Costs bandwidth and storage, buys back a piece of metadata.
   */
  p?: string;
  /**
   * A group's name, set by its owner.
   *
   * Sent as an encrypted control message rather than stored in a column, so
   * the server never learns that a group is called "Family" -- which would be
   * a lasting, plainly readable fact about the people in it, unlike the
   * messages, which expire.
   */
  n?: string;
};

export type MessagePayload = {
  text: string;
  replyToId?: string;
  editsMessageId?: string;
  /** Id of the message being reacted to; `text` is then the emoji, or ''. */
  reactsToMessageId?: string;
  /** Base64 audio for a voice message. `text` is empty for these. */
  audioBase64?: string;
  audioDurationMs?: number;
  /** Lifetime on the devices, in seconds, when it differs from the row's. */
  localTtlSeconds?: number;
  /** A group name being announced to the members. */
  groupName?: string;
};

/**
 * Payload sizes are rounded up to a multiple of this before encryption, so
 * that a recording's length is not readable from the row size. 64 KB keeps
 * the number of distinct sizes small without wasting much on a short clip.
 */
const PADDING_BUCKET = 64 * 1024;

export function encodePayload(payload: MessagePayload): string {
  if (
    !payload.replyToId &&
    !payload.editsMessageId &&
    !payload.reactsToMessageId &&
    !payload.audioBase64 &&
    !payload.localTtlSeconds &&
    payload.groupName === undefined
  ) {
    // Unchanged wire format for the overwhelmingly common case.
    return payload.text;
  }
  const encoded: Encoded = { k: MARKER, t: payload.text };
  if (payload.replyToId) encoded.r = payload.replyToId;
  if (payload.editsMessageId) encoded.e = payload.editsMessageId;
  if (payload.reactsToMessageId) encoded.x = payload.reactsToMessageId;
  if (payload.audioDurationMs) encoded.d = payload.audioDurationMs;
  if (payload.localTtlSeconds) encoded.l = payload.localTtlSeconds;
  if (payload.groupName !== undefined) encoded.n = payload.groupName;

  if (!payload.audioBase64) return JSON.stringify(encoded);

  encoded.a = payload.audioBase64;
  const unpadded = JSON.stringify(encoded);
  const target = Math.ceil(unpadded.length / PADDING_BUCKET) * PADDING_BUCKET;
  // The padding field costs a few characters of its own, so the fill is
  // measured against the string that will actually be produced.
  const overhead = JSON.stringify({ ...encoded, p: '' }).length;
  const fill = Math.max(0, target - overhead);
  return JSON.stringify({ ...encoded, p: '0'.repeat(fill) });
}

export function decodePayload(raw: string): MessagePayload {
  // Cheap guard before attempting a parse: the vast majority of messages are
  // plain text and would only make JSON.parse throw.
  if (!raw.startsWith('{')) return { text: raw };

  try {
    const parsed = JSON.parse(raw) as Partial<Encoded>;
    if (parsed?.k !== MARKER || typeof parsed.t !== 'string') {
      return { text: raw };
    }
    return {
      text: parsed.t,
      replyToId: typeof parsed.r === 'string' ? parsed.r : undefined,
      editsMessageId: typeof parsed.e === 'string' ? parsed.e : undefined,
      reactsToMessageId: typeof parsed.x === 'string' ? parsed.x : undefined,
      audioBase64: typeof parsed.a === 'string' ? parsed.a : undefined,
      audioDurationMs: typeof parsed.d === 'number' ? parsed.d : undefined,
      localTtlSeconds: typeof parsed.l === 'number' ? parsed.l : undefined,
      groupName: typeof parsed.n === 'string' ? parsed.n : undefined,
    };
  } catch {
    // Genuinely just a message that starts with a brace.
    return { text: raw };
  }
}
