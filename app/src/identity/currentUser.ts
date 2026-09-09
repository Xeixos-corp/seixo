/**
 * This device's own user id, once registration has completed.
 *
 * Needed synchronously in places that cannot wait on a promise -- the message
 * ingest path in particular, which has to know which copy of a group message
 * belongs to this device before it can decrypt anything.
 */
let currentUserId: string | null = null;

export function setCurrentUserId(userId: string | null): void {
  currentUserId = userId;
}

export function getCurrentUserId(): string | null {
  return currentUserId;
}
