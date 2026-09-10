import { requireOptionalNativeModule } from 'expo-modules-core';

type AudioSessionModule = {
  configureForPlayback(): Promise<void>;
  configureForRecording(): Promise<void>;
  startEarpieceRouting(): Promise<void>;
  stopEarpieceRouting(): Promise<void>;
};

/**
 * Optional on purpose: a build made before this module existed has no native
 * side for it, and audio should still work there -- just without Bluetooth
 * recording or earpiece routing. Same guard as security/appLock.ts, for the
 * same reason.
 */
const native = requireOptionalNativeModule<AudioSessionModule>('AudioSessionExpo');

/**
 * Every call here is best-effort and never throws.
 *
 * This module improves audio routing; it is not what makes recording or
 * playback work. When an invalid category option made configureForPlayback
 * fail with OSStatus -50, the rejection propagated and took the whole
 * stop-recording path with it -- so a routing nicety broke the feature it was
 * meant to improve, and the recording was lost. Nothing here is worth that.
 */
async function attempt(label: string, run: (() => Promise<void>) | undefined): Promise<void> {
  if (!run) return;
  try {
    await run();
  } catch (error) {
    console.warn(`[audioSession] ${label} failed; continuing without it`, error);
  }
}

export async function configureForPlayback(): Promise<void> {
  await attempt('configureForPlayback', native?.configureForPlayback.bind(native));
}

export async function configureForRecording(): Promise<void> {
  await attempt('configureForRecording', native?.configureForRecording.bind(native));
}

export async function startEarpieceRouting(): Promise<void> {
  await attempt('startEarpieceRouting', native?.startEarpieceRouting.bind(native));
}

export async function stopEarpieceRouting(): Promise<void> {
  await attempt('stopEarpieceRouting', native?.stopEarpieceRouting.bind(native));
}
