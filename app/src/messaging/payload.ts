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
  /**
   * Deletes a message from every phone in the conversation: the id of the
   * message to remove.
   *
   * Deleting the row on the server only reached the phones that happened to
   * be connected at that moment (the realtime DELETE event). A phone that was
   * closed kept its copy until its own timer ran out -- which, for a photo,
   * could be days. This travels like any other message, so it waits on the
   * server for a phone that is offline and is applied when it comes back.
   */
  z?: string;
  /**
   * A notice that the sender took a screenshot of this conversation. Shown to
   * everyone in it as a line of its own, not as a message bubble. A courtesy,
   * not a protection: another phone's camera is never detected.
   */
  s?: 1;
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
  /**
   * An image. Not the picture itself -- that is sealed and stored as its own
   * object, named after this message (messaging/attachments.ts). What travels
   * here, inside the encryption, is what opens it: the key, its size, and a
   * tiny blurred preview to show while the real thing downloads.
   */
  i?: EncodedImage;
  /**
   * A file: a PDF, a spreadsheet, a document. Stored and sealed exactly like
   * an image; what travels here is what opens it and what to call it. The
   * name and kind live only inside the encryption, so the server never learns
   * that someone sent "Contrato.pdf".
   */
  f?: EncodedFile;
  /**
   * A location, sent once on purpose from the paperclip menu. Only here,
   * inside the encryption: the server never learns where anyone is.
   */
  g?: EncodedLocation;
  /**
   * A voice-call signal: starting a call, answering it, ending it. Calls
   * travel as ordinary Seixo messages, encrypted like any other, so the server
   * sees a row in the conversation and cannot tell a call from a message --
   * not that one happened, not how long it lasted, not who hung up.
   */
  v?: EncodedCall;
};

type EncodedCall = {
  /** The call's id, made on the caller's phone; ties the signals together. */
  i: string;
  /**
   * o: offer (ringing), a: answer, e: end, r: declined, b: busy,
   * u: a new offer mid-call (renegotiation), w: the answer to it.
   */
  y: 'o' | 'a' | 'e' | 'r' | 'b' | 'u' | 'w';
  /** The WebRTC session description, for an offer or an answer. */
  s?: string;
  /** For an end: how long the call lasted, in seconds, when it was answered. */
  d?: number;
};

type EncodedLocation = {
  /** Latitude and longitude, in degrees, to five decimals (about a metre). */
  a: number;
  o: number;
  /** Horizontal accuracy in metres, as the phone reported it. */
  c?: number;
};

type EncodedFile = {
  /** The key that opens the stored object. */
  k: string;
  /** The name it had on the sender's phone. */
  n: string;
  /** Its real size in bytes, before padding. */
  s: number;
  /** Its MIME type, when the sender's phone knew it. */
  m?: string;
};

type EncodedImage = {
  /** The key that opens the stored object. The one secret in the image. */
  k: string;
  w: number;
  h: number;
  /** A few hundred bytes of JPEG, blurred when drawn. */
  b?: string;
};

export type ImagePayload = {
  keyBase64: string;
  width: number;
  height: number;
  previewBase64?: string;
};

export type FilePayload = {
  keyBase64: string;
  name: string;
  size: number;
  mimeType?: string;
};

export type LocationPayload = {
  latitude: number;
  longitude: number;
  accuracyMeters?: number;
};

/**
 * `renegotiate` and `renegotiateAnswer` change a call that is already
 * connected: the other side adds or changes what it sends. Used by the demo
 * account, whose echo comes from Cloudflare's SFU and can only be sent back
 * after a second exchange (supabase/functions/demo-account).
 */
export type CallSignalKind = 'offer' | 'answer' | 'end' | 'declined' | 'busy' | 'renegotiate' | 'renegotiateAnswer';

export type CallSignal = {
  callId: string;
  kind: CallSignalKind;
  sdp?: string;
  durationSeconds?: number;
};

const CALL_KIND_CODES: Record<CallSignalKind, EncodedCall['y']> = {
  offer: 'o',
  answer: 'a',
  end: 'e',
  declined: 'r',
  busy: 'b',
  renegotiate: 'u',
  renegotiateAnswer: 'w',
};

export type MessagePayload = {
  text: string;
  replyToId?: string;
  editsMessageId?: string;
  /** Id of the message being reacted to; `text` is then the emoji, or ''. */
  reactsToMessageId?: string;
  /** Id of the message to remove from every phone. */
  deletesMessageId?: string;
  /** The sender took a screenshot of the conversation. */
  screenshot?: boolean;
  /** Base64 audio for a voice message. `text` is empty for these. */
  audioBase64?: string;
  audioDurationMs?: number;
  /** Lifetime on the devices, in seconds, when it differs from the row's. */
  localTtlSeconds?: number;
  /** A group name being announced to the members. */
  groupName?: string;
  image?: ImagePayload;
  file?: FilePayload;
  location?: LocationPayload;
  call?: CallSignal;
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
    !payload.deletesMessageId &&
    !payload.screenshot &&
    !payload.audioBase64 &&
    !payload.localTtlSeconds &&
    payload.groupName === undefined &&
    !payload.image &&
    !payload.file &&
    !payload.location &&
    !payload.call
  ) {
    // Unchanged wire format for the overwhelmingly common case.
    return payload.text;
  }
  const encoded: Encoded = { k: MARKER, t: payload.text };
  if (payload.replyToId) encoded.r = payload.replyToId;
  if (payload.editsMessageId) encoded.e = payload.editsMessageId;
  if (payload.reactsToMessageId) encoded.x = payload.reactsToMessageId;
  if (payload.deletesMessageId) encoded.z = payload.deletesMessageId;
  if (payload.screenshot) encoded.s = 1;
  if (payload.audioDurationMs) encoded.d = payload.audioDurationMs;
  if (payload.localTtlSeconds) encoded.l = payload.localTtlSeconds;
  if (payload.groupName !== undefined) encoded.n = payload.groupName;
  if (payload.image) {
    encoded.i = {
      k: payload.image.keyBase64,
      w: payload.image.width,
      h: payload.image.height,
      b: payload.image.previewBase64,
    };
  }

  if (payload.file) {
    encoded.f = {
      k: payload.file.keyBase64,
      n: payload.file.name,
      s: payload.file.size,
      m: payload.file.mimeType,
    };
  }

  if (payload.location) {
    encoded.g = {
      a: Math.round(payload.location.latitude * 1e5) / 1e5,
      o: Math.round(payload.location.longitude * 1e5) / 1e5,
      c: payload.location.accuracyMeters !== undefined ? Math.round(payload.location.accuracyMeters) : undefined,
    };
  }

  if (payload.call) {
    encoded.v = {
      i: payload.call.callId,
      y: CALL_KIND_CODES[payload.call.kind],
      s: payload.call.sdp,
      d: payload.call.durationSeconds,
    };
  }

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
      deletesMessageId: typeof parsed.z === 'string' ? parsed.z : undefined,
      screenshot: parsed.s === 1 ? true : undefined,
      audioBase64: typeof parsed.a === 'string' ? parsed.a : undefined,
      audioDurationMs: typeof parsed.d === 'number' ? parsed.d : undefined,
      localTtlSeconds: typeof parsed.l === 'number' ? parsed.l : undefined,
      groupName: typeof parsed.n === 'string' ? parsed.n : undefined,
      image: decodeImage(parsed.i),
      file: decodeFile(parsed.f),
      location: decodeLocation(parsed.g),
      call: decodeCall(parsed.v),
    };
  } catch {
    // Genuinely just a message that starts with a brace.
    return { text: raw };
  }
}

/**
 * Accepts an image reference only if every field is the right kind of thing.
 * Anything half-formed is treated as no image at all: a message that claims a
 * picture and cannot say how to open it is better shown as its fallback text.
 */
function decodeImage(raw: unknown): ImagePayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const image = raw as Partial<EncodedImage>;
  if (
    typeof image.k !== 'string' ||
    typeof image.w !== 'number' ||
    typeof image.h !== 'number' ||
    image.w <= 0 ||
    image.h <= 0
  ) {
    return undefined;
  }
  return {
    keyBase64: image.k,
    width: image.w,
    height: image.h,
    previewBase64: typeof image.b === 'string' ? image.b : undefined,
  };
}

/**
 * Same rule as images: a file reference is accepted only whole. A name is
 * required to be non-empty text; it is cleaned again on the phone before it
 * becomes a file name (the native module keeps only a last path component).
 */
function decodeFile(raw: unknown): FilePayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const file = raw as Partial<EncodedFile>;
  if (
    typeof file.k !== 'string' ||
    typeof file.n !== 'string' ||
    !file.n.trim() ||
    typeof file.s !== 'number' ||
    file.s < 0
  ) {
    return undefined;
  }
  return {
    keyBase64: file.k,
    name: file.n.trim().slice(0, 200),
    size: file.s,
    mimeType: typeof file.m === 'string' ? file.m : undefined,
  };
}

/** A location is accepted only with real coordinates in range. */
function decodeLocation(raw: unknown): LocationPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const location = raw as Partial<EncodedLocation>;
  if (
    typeof location.a !== 'number' ||
    typeof location.o !== 'number' ||
    !Number.isFinite(location.a) ||
    !Number.isFinite(location.o) ||
    Math.abs(location.a) > 90 ||
    Math.abs(location.o) > 180
  ) {
    return undefined;
  }
  return {
    latitude: location.a,
    longitude: location.o,
    accuracyMeters:
      typeof location.c === 'number' && Number.isFinite(location.c) && location.c >= 0 ? location.c : undefined,
  };
}

/** A call signal is accepted only whole: an id and a kind this build knows. */
function decodeCall(raw: unknown): CallSignal | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const call = raw as Partial<EncodedCall>;
  if (typeof call.i !== 'string' || !call.i || call.i.length > 64) return undefined;
  const kind = (Object.keys(CALL_KIND_CODES) as CallSignalKind[]).find((k) => CALL_KIND_CODES[k] === call.y);
  if (!kind) return undefined;
  if (
    (kind === 'offer' || kind === 'answer' || kind === 'renegotiate' || kind === 'renegotiateAnswer') &&
    typeof call.s !== 'string'
  ) {
    return undefined;
  }
  return {
    callId: call.i,
    kind,
    sdp: typeof call.s === 'string' ? call.s : undefined,
    durationSeconds:
      typeof call.d === 'number' && Number.isFinite(call.d) && call.d >= 0 ? Math.round(call.d) : undefined,
  };
}
