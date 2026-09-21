import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import type { AppStateStatus } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useAppLockStore } from '../store/appLockStore';
import { unlock } from '../security/appLock';
import { tryOpenPendingConversation } from '../notifications/notificationRouting';
import { CodePad } from './CodePad';
import { checkCode } from '../security/lockCode';
import { panicWipe } from '../security/panicWipe';

/** Wrong codes allowed before a pause, and how long the first pause is. */
const FREE_ATTEMPTS = 5;
const FIRST_PAUSE_SECONDS = 30;

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
  const method = useAppLockStore((state) => state.method);
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
    // Tapping a notification on a locked app lands here: nothing behind the
    // lock is mounted, so the navigation could not happen until now.
    tryOpenPendingConversation();
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
    // A code is typed, not prompted for.
    if (method === 'code') return;
    if (!enabled || unlocked) {
      askedRef.current = false;
      return;
    }
    if (askedRef.current) return;
    askedRef.current = true;
    void attemptUnlock();
  }, [enabled, unlocked, attemptUnlock, method]);

  if (!enabled || unlocked) return <>{children}</>;

  if (method === 'code') return <CodeLock onUnlocked={() => {
    setUnlocked(true);
    tryOpenPendingConversation();
  }} />;

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

/**
 * The lock for 'code': the app's own keypad, and nothing else on screen.
 *
 * The panic code is handled here and looks exactly like the right code: the
 * same pause while it is checked, then the app opens -- as a fresh install,
 * welcome screen and all, because by then that is what it is
 * (security/panicWipe.ts). Nothing announces what happened. Someone standing
 * over the person sees a code typed and an app open.
 *
 * Wrong codes are allowed a few times, then cost a pause that doubles each
 * time. Never a wipe: a phone in a child's hands, or a shaking one, must not
 * be able to erase anyone's conversations by accident. Only the panic code
 * erases, and only on purpose.
 */
function CodeLock({ onUnlocked }: { onUnlocked: () => void }) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [wrong, setWrong] = useState(0);
  const [pausedUntil, setPausedUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (pausedUntil <= Date.now()) return;
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [pausedUntil]);

  const secondsLeft = Math.max(0, Math.ceil((pausedUntil - now) / 1000));

  const submit = useCallback(
    async (code: string) => {
      const result = await checkCode(code);
      if (result === 'panic') {
        await panicWipe();
        onUnlocked();
        return;
      }
      // 'missing': the codes are gone from the Keychain (restored phone,
      // cleared Keychain). Refusing would lock the person out of their own
      // conversations for good; there is nothing left to check against.
      if (result === 'unlock' || result === 'missing') {
        setWrong(0);
        onUnlocked();
        return;
      }
      const count = wrong + 1;
      setWrong(count);
      if (count >= FREE_ATTEMPTS) {
        const pause = FIRST_PAUSE_SECONDS * 2 ** (count - FREE_ATTEMPTS);
        setPausedUntil(Date.now() + pause * 1000);
        setNow(Date.now());
      }
    },
    [wrong, onUnlocked],
  );

  const message =
    secondsLeft > 0
      ? t('appLock.codePaused', { count: secondsLeft })
      : wrong > 0
        ? t('appLock.codeWrong')
        : t('appLock.codeBody');

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <CodePad
        title={t('appLock.lockedTitle')}
        message={message}
        error={wrong > 0}
        disabled={secondsLeft > 0}
        onComplete={submit}
      />
    </View>
  );
}
