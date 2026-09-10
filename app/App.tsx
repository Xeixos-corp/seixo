import React, { useEffect, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import './src/i18n';
import { ThemeProvider } from './src/theme/ThemeProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { resumeIdentityIfRegistered } from './src/identity/registerIdentity';
import { useScreenshotProtection } from './src/hooks/useScreenshotProtection';
import { ErrorBoundary } from './src/components/ErrorBoundary';
import { useMessageSync } from './src/messaging/useMessageSync';
import { AppLockGate } from './src/components/AppLockGate';
import { SplashOverlay } from './src/components/SplashOverlay';
import { usePushRegistration } from './src/notifications/usePushRegistration';
import { clearVoiceCache } from './src/audio/voiceFiles';

// Called before the component tree exists, which is the point: the native
// splash must be told to stay up before React has a chance to render a blank
// frame behind it. A rejection here is not worth handling -- the only
// consequence is the splash hiding on its own schedule.
void SplashScreen.preventAutoHideAsync().catch(() => {});

// How long the launch screen stays up at minimum. Long enough to read the
// name, short enough not to feel like a delay -- and the app is usually ready
// well before it elapses, so this is what decides the duration in practice.
const MINIMUM_SPLASH_MS = 1100;

export default function App() {
  useScreenshotProtection();
  // Receives messages for every conversation, not just the one on screen.
  useMessageSync();
  // Registers this device for push and keeps its token on the server.
  usePushRegistration();

  const [splashVisible, setSplashVisible] = useState(true);

  useEffect(() => {
    // Decrypted audio is written to disk only while it is playing, and
    // deleted immediately after -- but a crash or a force-quit mid-playback
    // skips that, and the file would then outlive the message it came from.
    // Emptying the directory at launch is the backstop.
    void clearVoiceCache();
  }, []);

  useEffect(() => {
    // Hand over from the native splash to SplashOverlay immediately. They are
    // drawn to look identical, so nothing changes on screen except that the
    // app's name can now appear under the icon.
    void SplashScreen.hideAsync().catch(() => {});
    const timer = setTimeout(() => setSplashVisible(false), MINIMUM_SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    // Fire-and-forget: OnboardingScreen awaits the same memoized promise to
    // show loading/error state, this just gets it started as early as
    // possible so returning users don't wait on the onboarding screen.
    //
    // Resume, not register: this must not create an account for someone who
    // has not asked for one. A fresh install that signed up here would leave
    // anyone restoring a backup already holding a different identity, and no
    // route back to theirs. Creating is the onboarding button's job.
    resumeIdentityIfRegistered().catch((error) => {
      console.error('[App] resumeIdentityIfRegistered failed', error);
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
        {/* Last child, so it covers everything -- including the lock screen,
            which should not flash into view during launch. */}
        <SplashOverlay visible={splashVisible} />
      </ThemeProvider>
    </ErrorBoundary>
  );
}
