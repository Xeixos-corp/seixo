import { requireOptionalNativeModule } from 'expo-modules-core';

type SharedBadgeModule = {
  setBadgeCount(count: number, appGroup: string): Promise<void>;
};

/**
 * Optional on purpose: a build made before this module existed has no native
 * side for it, and the app must keep working there -- just without a badge.
 * Same guard as modules/audio-session-expo, for the same reason.
 */
const native = requireOptionalNativeModule<SharedBadgeModule>('SharedBadgeExpo');

/**
 * Sets the number on the app icon and stores it for the Notification Service
 * Extension to count on from. Best-effort: never throws, because a badge is a
 * convenience and must not break whatever called it.
 */
export async function setBadgeCount(count: number, appGroup: string | undefined): Promise<void> {
  if (!native || !appGroup) return;
  try {
    await native.setBadgeCount(count, appGroup);
  } catch (error) {
    console.warn('[badge] could not set the badge count', error);
  }
}
