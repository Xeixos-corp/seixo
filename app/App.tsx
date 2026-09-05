import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import './src/i18n';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerIdentity } from './src/identity/registerIdentity';
import { useScreenshotProtection } from './src/hooks/useScreenshotProtection';
import { ErrorBoundary } from './src/components/ErrorBoundary';

export default function App() {
  useScreenshotProtection();

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
        <RootNavigator />
        <StatusBar style="auto" />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
