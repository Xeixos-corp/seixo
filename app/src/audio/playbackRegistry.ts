/**
 * Ensures only one voice message plays at a time, across the whole app.
 *
 * Each message bubble owns its own player, so without something above them
 * they happily play over each other: tapping a second message while the first
 * is still going gives you both at once. This is the piece that stops the one
 * already playing before a new one starts.
 */
let stopCurrent: (() => void) | null = null;

export function claimPlayback(stop: () => void): void {
  if (stopCurrent && stopCurrent !== stop) stopCurrent();
  stopCurrent = stop;
}

export function releasePlayback(stop: () => void): void {
  if (stopCurrent === stop) stopCurrent = null;
}
