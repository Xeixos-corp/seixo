import type { EncryptedEnvelope } from '../../modules/signal-native-expo/src/SignalNativeExpo.types';

/**
 * How a group message is packed before it is stored.
 *
 * The Signal Protocol encrypts between two devices, so a group message is
 * encrypted once per member: the same text, sealed separately with each
 * member's session. The recipient picks out the copy addressed to them.
 *
 * Two things travel outside the encryption, and both are deliberate.
 *
 * The **member ids** are the keys of the map. The server already knows who
 * belongs to a channel -- that is what channel_members is -- so this reveals
 * nothing it could not read one table over.
 *
 * The **sender** is in the clear, and that is a real cost. The recipient must
 * know whose session to decrypt with, and cannot know it after decrypting. It
 * lives inside the message, so it is deleted when the message expires on its
 * own timer: the server knows who spoke for as long as that message exists,
 * thirty seconds or a week, rather than forever. Decided 2026-09-10; see
 * docs/threat-model.md.
 */
const MARKER = 'seixo.group.v1';

type PackedGroupMessage = {
  k: typeof MARKER;
  /** Who sent it. Needed before decryption, so necessarily not encrypted. */
  f: string;
  /** member id -> the copy encrypted for that member */
  to: Record<string, EncryptedEnvelope>;
};

export function packGroupMessage(
  senderUserId: string,
  perMember: Record<string, EncryptedEnvelope>,
): string {
  const packed: PackedGroupMessage = { k: MARKER, f: senderUserId, to: perMember };
  return JSON.stringify(packed);
}

export type UnpackedGroupMessage = {
  senderUserId: string;
  envelope: EncryptedEnvelope;
};

/**
 * Returns the copy addressed to `selfUserId`, or null when this is not a group
 * message at all.
 *
 * A group message with no copy for this device is not an error worth
 * shouting about: it happens whenever someone was added between a message
 * being composed and being sent. Returning null lets the caller skip it
 * quietly rather than logging a decryption failure that means nothing.
 */
export function unpackGroupMessage(
  raw: string,
  selfUserId: string,
): UnpackedGroupMessage | null {
  if (!raw.startsWith('{')) return null;

  let parsed: Partial<PackedGroupMessage>;
  try {
    parsed = JSON.parse(raw) as Partial<PackedGroupMessage>;
  } catch {
    return null;
  }

  if (parsed?.k !== MARKER || typeof parsed.f !== 'string' || !parsed.to) return null;

  const envelope = parsed.to[selfUserId];
  if (!envelope) return null;

  return { senderUserId: parsed.f, envelope };
}

/** Whether a stored ciphertext is a group message, without unpacking it. */
export function isGroupMessage(raw: string): boolean {
  return raw.startsWith('{') && raw.includes(MARKER);
}
