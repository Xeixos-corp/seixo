import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as ScreenCapture from 'expo-screen-capture';

/**
 * Always-on, app-wide (see App.tsx) — no per-conversation or Settings
 * toggle, matching this app's private-by-default posture.
 *
 * Android: usePreventScreenCapture() sets FLAG_SECURE, which genuinely
 * blocks screenshots and screen recording at the OS level (the same
 * mechanism banking apps and Signal's own "Screen Security" use) — not a
 * false sense of security, it actually prevents the capture. It also
 * blanks the app's preview in the recent-apps switcher for free.
 *
 * iOS: Apple provides no API to block screenshots (only screen
 * *recording*, which usePreventScreenCapture also covers on iOS 11+) — a
 * screenshot can only be detected after it already happened, via
 * addScreenshotListener. We only warn the person who took it; there's no
 * peer notification (see the decision behind this in the session that
 * added it — avoids a new encrypted message type for a protection that a
 * second physical camera photographing the screen defeats regardless).
 *
 * The listener is iOS-only on purpose: on Android it would require the
 * READ_EXTERNAL_STORAGE permission, and would never fire anyway since
 * screenshots are already blocked there before they happen.
 */
// DISABLED ON iOS (2026-09-04) -- hypothesis test for a startup crash.
//
// The first TestFlight (Release) build crashed ~260ms after launch with
// SIGABRT on `com.meta.react.turbomodulemanager.queue`:
//   objc_exception_rethrow -> std::__terminate -> abort
// i.e. a native module threw an NSException that nothing caught. That's the
// signature of a known upstream React Native bug on iOS 26 release builds
// (facebook/react-native#54859): when an async *void* TurboModule method
// throws, performVoidMethodInvocation rethrows on a background GCD queue
// where nothing can catch it, so the app aborts instead of surfacing an
// error. Debug builds are unaffected -- which is exactly why the
// `development` profile ran fine on the same phone. See also
// expo/expo#44680 (same signature, A18 Pro + iOS 26, unresolved).
//
// `preventScreenCaptureAsync()` -- what usePreventScreenCapture calls -- is
// the only async-void native call this app makes unconditionally at
// startup, so it is the prime suspect. Disabling it on iOS costs little:
// per the comment above, Apple offers no way to block *screenshots*, so all
// it bought here was screen-*recording* prevention. The screenshot
// detection below (addScreenshotListener) is a separate API, unaffected.
// Android keeps it -- FLAG_SECURE is where the real protection lives.
//
// Resolved at module scope rather than branching inside the component, so
// the hook call order stays constant (Platform.OS never changes at runtime).
// If this turns out not to be the culprit, restore it rather than leaving
// iOS without recording protection for no reason.
const usePreventScreenCaptureUnlessIOS =
  Platform.OS === 'ios' ? () => {} : ScreenCapture.usePreventScreenCapture;

export function useScreenshotProtection(): void {
  const { t } = useTranslation();

  usePreventScreenCaptureUnlessIOS();

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const subscription = ScreenCapture.addScreenshotListener(() => {
      Alert.alert(t('screenshotWarning.title'), t('screenshotWarning.message'));
    });

    return () => subscription.remove();
  }, [t]);
}
