import { requireOptionalNativeModule } from 'expo-modules-core';

type Subscription = { remove(): void };

type CallsModule = {
  getVoipToken(): string | null;
  reportIncomingCall(callId: string, name: string | null): Promise<boolean>;
  startOutgoingCall(callId: string, name: string | null): Promise<boolean>;
  reportOutgoingConnected(callId: string): Promise<void>;
  endCall(callId: string, reason: string): Promise<void>;
  setMuted(callId: string, muted: boolean): Promise<void>;
  addListener(event: string, listener: (body: Record<string, unknown>) => void): Subscription;
};

/**
 * Optional, like the other local modules: a build made before calls existed
 * has no native side, and the app must still run there -- calls then work
 * only while the app is open, with the app's own screen.
 */
const native = requireOptionalNativeModule<CallsModule>('CallsExpo');

/** Whether this build has CallKit and VoIP pushes. */
export const hasCallKit = native !== null;

export function getVoipToken(): string | null {
  try {
    return native?.getVoipToken() || null;
  } catch {
    return null;
  }
}

async function attempt<T>(label: string, fallback: T, run: (() => Promise<T>) | undefined): Promise<T> {
  if (!run) return fallback;
  try {
    return await run();
  } catch (error) {
    console.warn(`[callsExpo] ${label} failed`, error);
    return fallback;
  }
}

/** Shows (or renames) an incoming call on the iPhone's own call screen. */
export function reportIncomingCall(callId: string, name: string | null): Promise<boolean> {
  return attempt('reportIncomingCall', false, native ? () => native.reportIncomingCall(callId, name) : undefined);
}

export function startOutgoingCall(callId: string, name: string | null): Promise<boolean> {
  return attempt('startOutgoingCall', false, native ? () => native.startOutgoingCall(callId, name) : undefined);
}

export function reportOutgoingConnected(callId: string): Promise<void> {
  return attempt('reportOutgoingConnected', undefined, native ? () => native.reportOutgoingConnected(callId) : undefined);
}

/** `local` when this phone hung up; otherwise remote, unanswered, declined or failed. */
export function endCall(callId: string, reason: 'local' | 'remote' | 'unanswered' | 'declined' | 'failed'): Promise<void> {
  return attempt('endCall', undefined, native ? () => native.endCall(callId, reason) : undefined);
}

export function setCallMuted(callId: string, muted: boolean): Promise<void> {
  return attempt('setMuted', undefined, native ? () => native.setMuted(callId, muted) : undefined);
}

export type CallKitEvent =
  | { type: 'voipToken'; token: string }
  | { type: 'incoming'; callId: string }
  | { type: 'answer'; callId: string }
  | { type: 'end'; callId: string }
  | { type: 'mute'; callId: string; muted: boolean }
  | { type: 'reset' }
  | { type: 'audioActivated' }
  | { type: 'audioDeactivated' };

/** Listens to everything CallKit and PushKit report. Returns an unsubscribe function. */
export function onCallKitEvent(listener: (event: CallKitEvent) => void): () => void {
  if (!native) return () => {};
  const map: [string, (body: Record<string, unknown>) => CallKitEvent][] = [
    ['onVoipToken', (b) => ({ type: 'voipToken', token: String(b.token ?? '') })],
    ['onIncomingCall', (b) => ({ type: 'incoming', callId: String(b.callId ?? '') })],
    ['onAnswer', (b) => ({ type: 'answer', callId: String(b.callId ?? '') })],
    ['onEnd', (b) => ({ type: 'end', callId: String(b.callId ?? '') })],
    ['onMute', (b) => ({ type: 'mute', callId: String(b.callId ?? ''), muted: b.muted === true })],
    ['onReset', () => ({ type: 'reset' })],
    ['onAudioActivated', () => ({ type: 'audioActivated' })],
    ['onAudioDeactivated', () => ({ type: 'audioDeactivated' })],
  ];
  const subscriptions = map.map(([name, convert]) => {
    try {
      return native.addListener(name, (body) => listener(convert(body ?? {})));
    } catch (error) {
      console.warn('[callsExpo] could not listen for', name, error);
      return { remove() {} };
    }
  });
  return () => subscriptions.forEach((s) => s.remove());
}
