import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { SettingsGroup, SettingsRow } from '../components/SettingsGroup';
import { CodePad } from '../components/CodePad';
import { useAppLockStore } from '../store/appLockStore';
import { isAppLockAvailable } from '../security/appLock';
import {
  clearCodes,
  clearPanicCode,
  hasPanicCode,
  isUnlockCode,
  setPanicCode,
  setUnlockCode,
} from '../security/lockCode';

type Choice = 'off' | 'device' | 'code';

/**
 * How the app is locked, and the panic code.
 *
 * The panic code lives here, one level down from Settings, on purpose: it is
 * not something to switch on by brushing past it, and everything about it --
 * what it erases, that it cannot be undone, that a forgotten code has no way
 * back -- has to be read before it is set.
 */
export function AppLockSettingsScreen() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const enabled = useAppLockStore((state) => state.enabled);
  const method = useAppLockStore((state) => state.method);
  const setEnabled = useAppLockStore((state) => state.setEnabled);
  const setMethod = useAppLockStore((state) => state.setMethod);
  const [deviceAvailable, setDeviceAvailable] = useState<boolean | null>(null);
  const [panicOn, setPanicOn] = useState(false);
  const [setting, setSetting] = useState<'unlock' | 'panic' | null>(null);

  const current: Choice = !enabled ? 'off' : method;

  const refreshPanic = useCallback(() => {
    hasPanicCode()
      .then(setPanicOn)
      .catch(() => setPanicOn(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    isAppLockAvailable().then((available) => {
      if (!cancelled) setDeviceAvailable(available);
    });
    refreshPanic();
    return () => {
      cancelled = true;
    };
  }, [refreshPanic]);

  // Leaving the code behind takes the panic code with it: it only exists on
  // the app's own keypad. Said before it happens, when there is one.
  const confirmLeavingCode = (then: () => void) => {
    if (!(current === 'code' && panicOn)) {
      then();
      return;
    }
    Alert.alert(t('lockSettings.leaveCodeTitle'), t('lockSettings.leaveCodeBody'), [
      { text: t('conversation.cancel'), style: 'cancel' },
      { text: t('lockSettings.leaveCodeConfirm'), style: 'destructive', onPress: then },
    ]);
  };

  const choose = (choice: Choice) => {
    if (choice === current) return;
    if (choice === 'code') {
      setSetting('unlock');
      return;
    }
    confirmLeavingCode(() => {
      void clearCodes().finally(refreshPanic);
      if (choice === 'off') {
        setEnabled(false);
      } else {
        setMethod('device');
        setEnabled(true);
      }
    });
  };

  const explainPanic = () => {
    Alert.alert(t('lockSettings.panicExplainTitle'), t('lockSettings.panicExplainBody'), [
      { text: t('conversation.cancel'), style: 'cancel' },
      { text: t('lockSettings.panicExplainContinue'), onPress: () => setSetting('panic') },
    ]);
  };

  const managePanic = () => {
    Alert.alert(t('lockSettings.panicLabel'), undefined, [
      { text: t('lockSettings.panicChange'), onPress: () => setSetting('panic') },
      {
        text: t('lockSettings.panicTurnOff'),
        style: 'destructive',
        onPress: () => void clearPanicCode().finally(refreshPanic),
      },
      { text: t('conversation.cancel'), style: 'cancel' },
    ]);
  };

  const onCodeSet = async (code: string) => {
    if (setting === 'unlock') {
      await setUnlockCode(code);
      setMethod('code');
      setEnabled(true);
    } else if (setting === 'panic') {
      await setPanicCode(code);
    }
    setSetting(null);
    refreshPanic();
  };

  const option = (choice: Choice, label: string, hint?: string, disabled?: boolean) => (
    <SettingsRow
      label={label}
      hint={hint}
      value={current === choice ? '✓' : undefined}
      onPress={() => choose(choice)}
      disabled={disabled}
    />
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <SettingsGroup title={t('lockSettings.methodSection')} footer={t('lockSettings.methodFooter')}>
          {option('off', t('lockSettings.off'))}
          {option(
            'device',
            t('lockSettings.device'),
            deviceAvailable === false ? t('settings.appLockUnavailable') : t('lockSettings.deviceHint'),
            deviceAvailable !== true,
          )}
          {option('code', t('lockSettings.code'), t('lockSettings.codeHint'))}
        </SettingsGroup>

        {current === 'code' ? (
          <SettingsGroup footer={t('lockSettings.panicFooter')}>
            <SettingsRow label={t('lockSettings.changeCode')} onPress={() => setSetting('unlock')} opensScreen />
            <SettingsRow
              label={t('lockSettings.panicLabel')}
              hint={t('lockSettings.panicHint')}
              value={panicOn ? t('lockSettings.on') : t('lockSettings.offShort')}
              onPress={panicOn ? managePanic : explainPanic}
              opensScreen
            />
          </SettingsGroup>
        ) : null}
      </ScrollView>

      <CodeSetupModal
        purpose={setting}
        onCancel={() => setSetting(null)}
        onDone={onCodeSet}
      />
    </SafeAreaView>
  );
}

/**
 * Asks for a new code twice, and refuses a panic code equal to the unlock
 * code -- the one mistake here that would make every unlock a wipe.
 */
function CodeSetupModal({
  purpose,
  onCancel,
  onDone,
}: {
  purpose: 'unlock' | 'panic' | null;
  onCancel: () => void;
  onDone: (code: string) => Promise<void>;
}) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [first, setFirst] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setFirst(null);
    setError(null);
  }, [purpose]);

  const complete = async (code: string) => {
    if (first === null) {
      if (purpose === 'panic' && (await isUnlockCode(code))) {
        setError(t('lockSettings.panicSameAsUnlock'));
        return;
      }
      setError(null);
      setFirst(code);
      return;
    }
    if (code !== first) {
      setFirst(null);
      setError(t('lockSettings.mismatch'));
      return;
    }
    try {
      await onDone(code);
    } catch (cause) {
      console.warn('[lockSettings] could not save the code', cause instanceof Error ? cause.message : cause);
      setFirst(null);
      setError(t('lockSettings.saveFailed'));
    }
  };

  const title =
    purpose === 'panic'
      ? first === null
        ? t('lockSettings.panicEnterTitle')
        : t('lockSettings.panicConfirmTitle')
      : first === null
        ? t('lockSettings.codeEnterTitle')
        : t('lockSettings.codeConfirmTitle');

  const message =
    error ?? (purpose === 'panic' ? t('lockSettings.panicEnterBody') : t('lockSettings.codeEnterBody'));

  return (
    <Modal visible={purpose !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onCancel}>
      <View style={[styles.modal, { backgroundColor: colors.background }]}>
        <Pressable onPress={onCancel} hitSlop={12} style={styles.cancel}>
          <Text style={{ color: colors.accent, fontSize: 16 }}>{t('conversation.cancel')}</Text>
        </Pressable>
        <CodePad title={title} message={message} error={Boolean(error)} onComplete={complete} />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingHorizontal: 20, paddingBottom: 32 },
  modal: { flex: 1, paddingTop: 16, justifyContent: 'center' },
  cancel: { position: 'absolute', top: 20, left: 20 },
});
