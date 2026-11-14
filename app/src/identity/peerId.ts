/**
 * Recognising a Seixo ID in whatever someone types or pastes.
 *
 * Seixo has no usernames and no phone numbers: the only way to reach someone
 * is their ID, a UUID. People do not know that. The server logs showed names
 * typed into the field ("addison", over and over) and the raw Postgres error
 * coming back. And even someone doing it right could fail: "Partilhar o meu
 * ID" sends "O meu ID da Seixo: <id>", and pasting that whole message used to
 * send the sentence along with the ID.
 *
 * So the ID is looked for anywhere in the text, and if there is none, the
 * request is never made: the person is told what an ID is instead.
 */

/** An ID on its own, as the QR code from MyIdCard.tsx carries it. */
export const PEER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PEER_ID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * The ID inside `text`, lower-cased as the server stores it, or null.
 *
 * Only the first one: a pasted message with two IDs in it is ambiguous, but
 * the shared message carries exactly one, and that is the case to get right.
 */
export function findPeerId(text: string): string | null {
  const match = PEER_ID_ANYWHERE.exec(text);
  return match ? match[0].toLowerCase() : null;
}

/** RPC errors surface the Postgres RAISE EXCEPTION text as error.message. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A well-formed ID that belongs to no account: mistyped, or deleted. */
export function isPeerNotFoundError(error: unknown): boolean {
  return messageOf(error).includes('peer identity not found');
}

/** add_group_member refuses an eleventh member (0018_group_channels.sql). */
export function isGroupFullError(error: unknown): boolean {
  return messageOf(error).includes('group is full');
}

/** add_group_member refuses someone either side has blocked. */
export function isBlockedMemberError(error: unknown): boolean {
  return messageOf(error).includes('blocked: cannot add this user');
}
