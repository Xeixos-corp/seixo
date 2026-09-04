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
export function useScreenshotProtection(): void {
  const { t } = useTranslation();

  ScreenCapture.usePreventScreenCapture();

  useEffect(() => {
    if (Platform.OS !== 'ios') return;

    const subscription = ScreenCapture.addScreenshotListener(() => {
      Alert.alert(t('screenshotWarning.title'), t('screenshotWarning.message'));
    });

    return () => subscription.remove();
  }, [t]);
}
