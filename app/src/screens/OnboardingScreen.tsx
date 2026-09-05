import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { registerIdentity } from '../identity/registerIdentity';
import { supabase } from '../transport/supabaseClient';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

// 'checking' is the state this screen now starts in: we don't yet know
// whether there's already an identity on this device, and showing "create
// your identity" to someone who created one weeks ago is wrong.
type Status = 'checking' | 'idle' | 'loading' | 'error';

export function OnboardingScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>('checking');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Skip onboarding entirely when this device already has an identity.
  // Previously this screen was the unconditional initial route, so every
  // single launch asked you to "create your identity" again, even though
  // registerIdentity() is idempotent and would just reuse the existing one.
  //
  // An existing Supabase session is the signal: signInAnonymouslyIfNeeded()
  // reuses it rather than creating a second anonymous user, so a session
  // means onboarding already happened. Reading it is a local AsyncStorage
  // lookup, so this stays fast and works offline -- deliberately *not*
  // awaiting registerIdentity() here, which would block launch on the
  // network. App.tsx already kicked that off in the background.
  useEffect(() => {
    let cancelled = false;

    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        if (data.session?.user) {
          navigation.replace('ConversationList');
        } else {
          setStatus('idle');
        }
      })
      .catch(() => {
        // Can't tell either way -- fall back to showing the button rather
        // than stranding the user on a spinner. Tapping it is harmless if
        // an identity already exists.
        if (!cancelled) setStatus('idle');
      });

    return () => {
      cancelled = true;
    };
  }, [navigation]);

  const handleCreateIdentity = async () => {
    setStatus('loading');
    setErrorMessage(null);
    try {
      // Reuses the promise App.tsx already kicked off on launch, if any —
      // registerIdentity() is memoized and safe to call again.
      await registerIdentity();
      navigation.replace('ConversationList');
    } catch (error) {
      setStatus('error');
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  };

  if (status === 'checking') {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.content}>
          <Text style={[styles.brand, { color: colors.accent }]}>Seixo</Text>
          <ActivityIndicator color={colors.accent} />
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text style={[styles.brand, { color: colors.accent }]}>Seixo</Text>
        <Text style={[styles.title, { color: colors.textPrimary }]}>{t('onboarding.title')}</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('onboarding.subtitle')}</Text>
        {status === 'error' && errorMessage ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
        ) : null}
      </View>

      <Pressable
        disabled={status === 'loading'}
        style={({ pressed }) => [
          styles.primaryButton,
          { backgroundColor: pressed ? colors.accentPressed : colors.accent },
          status === 'loading' && styles.primaryButtonDisabled,
        ]}
        onPress={handleCreateIdentity}
      >
        {status === 'loading' ? (
          <ActivityIndicator color={colors.onAccent} />
        ) : (
          <Text style={[styles.primaryButtonText, { color: colors.onAccent }]}>
            {status === 'error' ? t('onboarding.retry') : t('onboarding.createIdentity')}
          </Text>
        )}
      </Pressable>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    padding: 24,
  },
  content: {
    flex: 1,
    justifyContent: 'center',
    gap: 12,
  },
  brand: {
    fontSize: 15,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.5,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
  },
  subtitle: {
    fontSize: 16,
    lineHeight: 22,
  },
  errorText: {
    fontSize: 14,
    marginTop: 8,
  },
  primaryButton: {
    borderRadius: 12,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 12,
  },
  primaryButtonDisabled: {
    opacity: 0.7,
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
