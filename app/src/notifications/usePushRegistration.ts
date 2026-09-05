import { useEffect } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { requireOptionalNativeModule } from 'expo-modules-core';
import { useTranslation } from 'react-i18next';
import { registerIdentity } from '../identity/registerIdentity';
import { upsertPushToken } from './pushTokens';

/**
 * Registers this device for push notifications and keeps its token on the
 * server.
 *
 * Gated behind `requireOptionalNativeModule`, for the same reason as
 * security/appLock.ts -- and the same trap: a try/catch around the import
 * does not work in a development bundle, because Metro reports the failure to
 * LogBox and returns `undefined` rather than rethrowing. See the comment
 * there for the full explanation.
 *
 * 'ExpoPushTokenManager' is the specific native module this hook cannot work
 * without: it is what issues the token, and it was the one named in the error
 * on a build that predates expo-notifications.
 */
type NotificationsModule = typeof import('expo-notifications');

let cached: NotificationsModule | null | undefined;

function loadModule(): NotificationsModule | null {
  if (cached !== undefined) return cached;

  if (!requireOptionalNativeModule('ExpoPushTokenManager')) {
    console.log('[push] no native ExpoPushTokenManager in this build; notifications unavailable');
    cached = null;
    return cached;
  }

  const loaded = require('expo-notifications') as NotificationsModule | undefined;
  cached = loaded ?? null;
  return cached;
}

// Set once a token has been published for the current identity, so an
// ordinary re-render or a language change doesn't re-publish it on every
// mount. Cleared by resetPushRegistration() when the account is deleted.
let registeredForUserId: string | null = null;

export function resetPushRegistration(): void {
  registeredForUserId = null;
}

export function usePushRegistration(): void {
  const { t } = useTranslation();

  useEffect(() => {
    let cancelled = false;

    async function register() {
      const Notifications = loadModule();
      if (!Notifications) return;

      // Show something even when the app is already open -- otherwise a
      // message arriving while the user is on the conversation list is
      // silently swallowed by iOS.
      Notifications.setNotificationHandler({
        handleNotification: async () => ({
          shouldShowAlert: true,
          shouldPlaySound: true,
          shouldSetBadge: false,
        }),
      });

      const existing = await Notifications.getPermissionsAsync();
      let status = existing.status;
      if (status !== 'granted') {
        // Asked only once by iOS; if the user says no, this returns
        // 'denied' forever after and there is nothing more to do here.
        status = (await Notifications.requestPermissionsAsync()).status;
      }
      if (status !== 'granted' || cancelled) return;

      // The identity is what ties a token to a user_id, and it also
      // establishes the Supabase session the upsert needs.
      const { userId } = await registerIdentity();
      if (cancelled || registeredForUserId === userId) return;

      const projectId =
        Constants.expoConfig?.extra?.eas?.projectId ??
        // Older manifest shape, still populated at runtime on some builds.
        Constants.easConfig?.projectId;
      if (!projectId) {
        console.warn('[push] no EAS projectId available; cannot get a push token');
        return;
      }

      const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
      if (cancelled) return;

      await upsertPushToken(
        userId,
        token,
        t('notifications.title'),
        // Deliberately contentless. The server could not include the message
        // even if it wanted to -- it only ever holds ciphertext -- but this
        // also keeps the text off the lock screen of a phone someone else is
        // holding.
        t('notifications.body'),
      );
      registeredForUserId = userId;
    }

    register().catch((error) => {
      // Never fatal: notifications are a convenience, and an app that
      // refuses to start because a push token failed is a worse app.
      console.warn('[push] registration failed', error);
    });

    return () => {
      cancelled = true;
    };
    // Platform is constant; listed to make the iOS-only assumption explicit
    // if this ever grows an Android branch.
  }, [t]);
}

export const PUSH_PLATFORM = Platform.OS;
