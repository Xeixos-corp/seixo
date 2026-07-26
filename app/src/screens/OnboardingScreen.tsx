import React, { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { registerIdentity } from '../identity/registerIdentity';
import type { RootStackParamList } from '../navigation/RootNavigator';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<RootStackParamList, 'Onboarding'>;

type Status = 'idle' | 'loading' | 'error';

export function OnboardingScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const [status, setStatus] = useState<Status>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.content}>
        <Text style={[styles.title, { color: colors.textPrimary }]}>Mensagens privadas</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>
          Cifra ponta-a-ponta. Sem número de telefone. Metadados mínimos e temporários.
        </Text>
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
            {status === 'error' ? 'Tentar novamente' : 'Criar identidade'}
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
