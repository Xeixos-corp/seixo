import React from 'react';
import { ScrollView, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAppTheme } from '../theme/ThemeProvider';
import { NotificationSoundPicker } from '../components/NotificationSoundPicker';

/**
 * The sound picker, on a screen of its own.
 *
 * It used to sit open inside Settings, where its five full-width options took
 * more vertical space than every other setting put together -- which said
 * that choosing a notification sound is the most important thing this app
 * does. A row showing the current choice says it properly, and the choosing
 * happens here.
 */
export function NotificationSoundScreen() {
  const { colors } = useAppTheme();
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        <NotificationSoundPicker />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: 20 },
});
