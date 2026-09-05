import { requireOptionalNativeModule } from 'expo-modules-core';
import type * as LocalAuthenticationTypes from 'expo-local-authentication';

/**
 * Face ID / device-passcode gate for opening the app.
 *
 * Every call goes through `loadModule()` rather than a top-level import.
 * expo-local-authentication is a *native* module, so any build made before it
 * was added -- including the development build currently on the test device --
 * has no native side for it. A static import there is evaluated while the JS
 * bundle is still loading, which takes the whole app down instead of just
 * this feature.
 *
 * The gate is `requireOptionalNativeModule`, not a try/catch around the
 * import. A try/catch looked like it worked and did not: in a development
 * bundle, Metro's `guardedLoadModule` reports a module that throws during
 * initialisation straight to LogBox and returns `undefined` instead of
 * rethrowing. So the catch never ran (no warning was ever logged), `cached`
 * was assigned `undefined` -- the very value used to mean "not tried yet" --
 * and every call retried and produced another red box. Asking whether the
 * native module exists *before* importing the JS wrapper avoids the throw
 * entirely, in both development and release builds.
 */
let cached: typeof LocalAuthenticationTypes | null | undefined;

function loadModule(): typeof LocalAuthenticationTypes | null {
  if (cached !== undefined) return cached;

  if (!requireOptionalNativeModule('ExpoLocalAuthentication')) {
    console.log('[appLock] no native ExpoLocalAuthentication in this build; lock unavailable');
    cached = null;
    return cached;
  }

  // Belt and braces: never let `undefined` back into `cached`, or the
  // memoisation silently turns into "retry on every call" again.
  const loaded = require('expo-local-authentication') as
    | typeof LocalAuthenticationTypes
    | undefined;
  cached = loaded ?? null;
  return cached;
}

/**
 * Whether this device can actually authenticate the user right now: the
 * hardware exists *and* a credential is enrolled.
 *
 * Both halves matter. Hardware alone is not enough -- a phone with a Face ID
 * sensor but no passcode set has nothing to check against, and enabling the
 * lock there would make the app permanently unopenable.
 */
export async function isAppLockAvailable(): Promise<boolean> {
  const auth = loadModule();
  if (!auth) return false;
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      auth.hasHardwareAsync(),
      auth.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch (error) {
    console.warn('[appLock] availability check failed', error);
    return false;
  }
}

export type UnlockResult =
  | { status: 'unlocked' }
  | { status: 'failed' }
  /**
   * No credential is enrolled any more (the user removed their passcode after
   * turning the lock on). Callers must let the user in.
   *
   * Refusing here would be a permanent lockout with no recovery path: the
   * message history lives only on this device (decryption consumes the
   * ratchet key, so the copies on the server can never be read again), and
   * there is no account password to fall back on. A lock that can brick the
   * app is worse than one that yields when the OS has nothing left to check.
   */
  | { status: 'unavailable' };

export async function unlock(promptMessage: string): Promise<UnlockResult> {
  const auth = loadModule();
  if (!auth) return { status: 'unavailable' };

  if (!(await isAppLockAvailable())) return { status: 'unavailable' };

  try {
    const result = await auth.authenticateAsync({
      promptMessage,
      // Device passcode stays available on purpose: Face ID fails for
      // ordinary reasons (a mask, bad light, a wet sensor) and the passcode
      // is the same credential class, not a weaker one.
      disableDeviceFallback: false,
      cancelLabel: undefined,
    });
    return result.success ? { status: 'unlocked' } : { status: 'failed' };
  } catch (error) {
    console.warn('[appLock] authenticateAsync threw', error);
    return { status: 'failed' };
  }
}
