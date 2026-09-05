import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useAppLockStore } from '../store/appLockStore';
import { unlock } from '../security/appLock';

/**
 * Hides the app behind Face ID (or the device passcode) until the user proves
 * who they are.
 *
 * This exists because message history is now stored on disk (see
 * messagesStore.ts) -- which was the right call for the app to be usable, but
 * it means someone holding the unlocked phone can read everything. The threat
 * model has always listed a compromised unlocked device as out of scope, and
 * still does; this covers the much more ordinary case it was silently lumped
 * in with: someone picking up a phone that is already unlocked.
 */
export function AppLockGate({ children }: { children: React.ReactNode }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const enabled = useAppLockStore((state) => state.enabled);
  const unlocked = useAppLockStore((state) => state.unlocked);
  const setUnlocked = useAppLockStore((state) => state.setUnlocked);
  const [prompting, setPrompting] = useState(false);
  const [failed, setFailed] = useState(false);

  const attemptUnlock = useCallback(async () => {
    setPrompting(true);
    const result = await unlock(t('appLock.prompt'));
    setPrompting(false);
    if (result.status === 'failed') {
      setFailed(true);
      return;
    }
    // 'unavailable' unlocks too, on purpose -- see UnlockResult in
    // security/appLock.ts for why refusing would be a permanent lockout.
    setFailed(false);
    setUnlocked(true);
  }, [setUnlocked, t]);

  // Re-lock when the app actually leaves the screen. Only 'background'
  // counts: iOS reports 'inactive' for things that are not the user leaving
  // -- notification shade, an incoming call banner, and the Face ID sheet
  // itself -- and re-locking on those would fight the unlock prompt.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'background') {
        setUnlocked(false);
        setFailed(false);
      }
    });
    return () => subscription.remove();
  }, [setUnlocked]);

  // Ask as soon as the app is locked, so the usual case is "open app, look at
  // it, you're in" with nothing to tap.
  const askedRef = useRef(false);
  useEffect(() => {
    if (!enabled || unlocked) {
      askedRef.current = false;
      return;
    }
    if (askedRef.current) return;
    askedRef.current = true;
    void attemptUnlock();
  }, [enabled, unlocked, attemptUnlock]);

  if (!enabled || unlocked) return <>{children}</>;

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('appLock.lockedTitle')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>
        {failed ? t('appLock.failedBody') : t('appLock.lockedBody')}
      </Text>
      <Pressable
        style={[styles.button, { backgroundColor: colors.accent }, prompting && styles.buttonBusy]}
        onPress={attemptUnlock}
        disabled={prompting}
      >
        <Text style={[styles.buttonText, { color: colors.onAccent }]}>
          {prompting ? t('appLock.unlocking') : t('appLock.unlockButton')}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  title: {
    fontSize: 20,
    fontWeight: '600',
    marginBottom: 10,
  },
  body: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    marginBottom: 28,
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  buttonBusy: {
    opacity: 0.6,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
