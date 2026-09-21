import { useEffect } from 'react';
import { Alert, Platform } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as ScreenCapture from 'expo-screen-capture';
import { getActiveConversation } from '../messaging/activeConversation';

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
 * addScreenshotListener. Inside a conversation, ConversationScreen tells
 * everyone in it (a notice, as its own line) -- this hook then stays quiet,
 * because that line says it better than an alert. Everywhere else, only the
 * person who took it is reminded.
 *
 * That notice reverses an earlier decision not to tell the other side, made
 * on the grounds that a second phone's camera defeats it anyway. Still true,
 * and the notice claims no more: it is a courtesy that makes a screenshot
 * here not silent, which is most of what deters one.
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
      if (getActiveConversation()) return;
      Alert.alert(t('screenshotWarning.title'), t('screenshotWarning.message'));
    });

    return () => subscription.remove();
  }, [t]);
}
