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

export async function configureForPlayback(): Promise<void> {
  await native?.configureForPlayback();
}

export async function configureForRecording(): Promise<void> {
  await native?.configureForRecording();
}

export async function startEarpieceRouting(): Promise<void> {
  await native?.startEarpieceRouting();
}

export async function stopEarpieceRouting(): Promise<void> {
  await native?.stopEarpieceRouting();
}
