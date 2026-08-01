import React, { useEffect } from 'react';
import { StatusBar } from 'expo-status-bar';
import './src/i18n';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { registerIdentity } from './src/identity/registerIdentity';

export default function App() {
  useEffect(() => {
    // Fire-and-forget: OnboardingScreen awaits the same memoized promise to
    // show loading/error state, this just gets it started as early as
    // possible so returning users don't wait on the onboarding screen.
    registerIdentity().catch((error) => {
      console.error('[App] registerIdentity failed', error);
    });
  }, []);

  return (
    <ThemeProvider>
      <RootNavigator />
      <StatusBar style="auto" />
    </ThemeProvider>
  );
}
