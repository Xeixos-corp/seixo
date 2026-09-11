import React from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { navigationRef } from './navigationRef';
import { tryOpenPendingConversation } from '../notifications/notificationRouting';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { ConversationListScreen } from '../screens/ConversationListScreen';
import { ConversationScreen } from '../screens/ConversationScreen';
import { BlockedPeersScreen } from '../screens/BlockedPeersScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { ScanQrScreen } from '../screens/ScanQrScreen';
import { BackupScreen } from '../screens/BackupScreen';
import { RestoreBackupScreen } from '../screens/RestoreBackupScreen';
import { ShareTargetScreen } from '../screens/ShareTargetScreen';

export type RootStackParamList = {
  Onboarding: undefined;
  ConversationList: undefined;
  /**
   * `initialDraft` pre-fills the input box -- used by sharing from another app,
   * which places text without ever sending it.
   */
  Conversation: { channelId: string; peerUserId: string; initialDraft?: string };
  BlockedPeers: undefined;
  Settings: undefined;
  ScanQr: undefined;
  Backup: undefined;
  RestoreBackup: undefined;
  ShareTarget: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator() {
  const { colors, colorScheme } = useAppTheme();
  const { t } = useTranslation();

  const navigationTheme = {
    ...(colorScheme === 'dark' ? DarkTheme : DefaultTheme),
    colors: {
      ...(colorScheme === 'dark' ? DarkTheme.colors : DefaultTheme.colors),
      background: colors.background,
      card: colors.surface,
      text: colors.textPrimary,
      border: colors.border,
      primary: colors.accent,
    },
  };

  return (
    <NavigationContainer
      ref={navigationRef}
      theme={navigationTheme}
      // A notification tapped while the app was closed is handled before any
      // of this exists, so the request waits here for somewhere to go.
      onReady={tryOpenPendingConversation}
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.surface },
          headerTintColor: colors.textPrimary,
          contentStyle: { backgroundColor: colors.background },
        }}
      >
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
        <Stack.Screen
          name="ConversationList"
          component={ConversationListScreen}
          // No header title: the screen draws its own, larger one. Having
          // both wrote "Conversas" twice and left the three header buttons
          // squeezed against it.
          options={{ title: '' }}
        />
        <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: t('navigation.conversation') }} />
        <Stack.Screen
          name="BlockedPeers"
          component={BlockedPeersScreen}
          options={{ title: t('navigation.blockedPeers') }}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t('navigation.settings') }} />
        <Stack.Screen name="ScanQr" component={ScanQrScreen} options={{ title: t('navigation.scanQr') }} />
        <Stack.Screen name="Backup" component={BackupScreen} options={{ title: t('navigation.backup') }} />
        <Stack.Screen
          name="ShareTarget"
          component={ShareTargetScreen}
          options={{ title: t('navigation.shareTarget') }}
        />
        <Stack.Screen
          name="RestoreBackup"
          component={RestoreBackupScreen}
          options={{ title: t('navigation.restoreBackup') }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
