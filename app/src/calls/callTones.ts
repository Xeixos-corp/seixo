import { createAudioPlayer, type AudioPlayer } from 'expo-audio';

/**
 * The tones a caller hears: ringback while the other phone rings, and a short
 * busy signal when the call is declined or the other person is on another
 * call. Without them a call was silence until answered, which reads as
 * "broken" (Bruno, 2026-11-23).
 *
 * The European tones (CEPT, as on Portuguese phones), generated for this app,
 * so there is nothing to license: 425 Hz, one second on and four off for
 * ringback; half a second on and off, three times, for busy
 * (assets/calls/*.wav).
 *
 * Played with expo-audio's player, which uses the call's audio session as it
 * is: creating and playing a player does not change the session's category,
 * so the tones come out of the earpiece like the call, and the microphone
 * WebRTC already holds is left alone.
 */

const RINGBACK = require('../../assets/calls/ringback.wav');
const BUSY = require('../../assets/calls/busy.wav');

let ringback: AudioPlayer | null = null;
let busy: AudioPlayer | null = null;

function release(player: AudioPlayer | null): void {
  try {
    player?.pause();
    player?.remove();
  } catch {
    // Already gone.
  }
}

export function startRingback(): void {
  if (ringback) return;
  try {
    ringback = createAudioPlayer(RINGBACK);
    ringback.loop = true;
    ringback.volume = 0.6;
    ringback.play();
  } catch (error) {
    console.warn('[callTones] ringback failed', error);
    ringback = null;
  }
}

export function stopRingback(): void {
  release(ringback);
  ringback = null;
}

/** Plays the busy signal once; about three seconds. */
export function playBusy(): void {
  stopRingback();
  release(busy);
  try {
    busy = createAudioPlayer(BUSY);
    busy.volume = 0.6;
    busy.play();
  } catch (error) {
    console.warn('[callTones] busy tone failed', error);
    busy = null;
  }
}

/** How long the busy signal lasts, so the call's audio can be kept until it ends. */
export const BUSY_TONE_MS = 3000;
