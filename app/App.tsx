import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import './src/i18n';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerIdentity } from './src/identity/registerIdentity';
import { useScreenshotProtection } from './src/hooks/useScreenshotProtection';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useMessageSync } from './src/messaging/useMessageSync';
import { AppLockGate } from './src/components/AppLockGate';
import { usePushRegistration } from './src/notifications/usePushRegistration';

export default function App() {
  useScreenshotProtection();
  // Receives messages for every conversation, not just the one on screen.
  useMessageSync();
  // Registers this device for push and keeps its token on the server.
  usePushRegistration();

  useEffect(() => {
    // Fire-and-forget: OnboardingScreen awaits the same memoized promise to
    // show loading/error state, this just gets it started as early as
    // possible so returning users don't wait on the onboarding screen.
    registerIdentity().catch((error) => {
      console.error('[App] registerIdentity failed', error);
    });
  }, []);

  return (
    // Outside ThemeProvider on purpose, so a failure in the theme itself is
    // still reported rather than showing a blank screen.
    <ErrorBoundary>
      <ThemeProvider>
        {/* Inside ThemeProvider (the lock screen needs colours) but outside
            the navigator, so nothing behind the lock is ever mounted or
            briefly visible. Message sync above stays running regardless --
            messages should keep arriving while the app is locked. */}
        <AppLockGate>
          <RootNavigator />
        </AppLockGate>
        <StatusBar style="auto" />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
