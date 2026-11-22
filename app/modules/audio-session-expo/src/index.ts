import { requireOptionalNativeModule } from 'expo-modules-core';

type AudioSessionModule = {
  configureForPlayback(): Promise<void>;
  configureForRecording(): Promise<void>;
  startEarpieceRouting(): Promise<void>;
  stopEarpieceRouting(): Promise<void>;
  startCallAudio?(activate: boolean): Promise<void>;
  stopCallAudio?(): Promise<void>;
  setCallSpeaker?(on: boolean): Promise<void>;
  addListener?(event: 'onAudioInterruption', listener: () => void): { remove(): void };
  addListener?(event: 'onCallRouteChange', listener: (body: { speaker?: boolean }) => void): { remove(): void };
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

/**
 * Called when iOS takes the audio session away mid-recording -- a call
 * arriving, Siri, another app claiming the microphone.
 *
 * Returns an unsubscribe function, and one that does nothing on a build whose
 * native side predates this event: `addListener` is optional for the same
 * reason the whole module is, and an older build simply never reports an
 * interruption rather than crashing on a listener it cannot register.
 */
export function onAudioInterruption(listener: () => void): () => void {
  try {
    const subscription = native?.addListener?.('onAudioInterruption', listener);
    return () => subscription?.remove();
  } catch (error) {
    console.warn('[audioSession] could not listen for interruptions', error);
    return () => {};
  }
}

/** Session and routing for a voice call (calls/callManager.ts). */
/**
 * `activate` is false when CallKit is in charge of the call: it activates the
 * session itself, and activating it here as well can leave a call silent.
 */
export async function startCallAudio(activate = true): Promise<void> {
  const run = native?.startCallAudio?.bind(native);
  await attempt('startCallAudio', run ? () => run(activate) : undefined);
}

export async function stopCallAudio(): Promise<void> {
  await attempt('stopCallAudio', native?.stopCallAudio?.bind(native));
}

export async function setCallSpeaker(on: boolean): Promise<void> {
  const run = native?.setCallSpeaker?.bind(native);
  await attempt('setCallSpeaker', run ? () => run(on) : undefined);
}

/**
 * Called when a call's sound moves to or from the speaker by some other means
 * than the app's own button: iOS's call screen, headphones, a car.
 */
export function onCallRouteChange(listener: (speaker: boolean) => void): () => void {
  try {
    const subscription = native?.addListener?.('onCallRouteChange', (body: { speaker?: boolean }) =>
      listener(body?.speaker === true),
    );
    return () => subscription?.remove();
  } catch (error) {
    console.warn('[audioSession] could not listen for call route changes', error);
    return () => {};
  }
}
