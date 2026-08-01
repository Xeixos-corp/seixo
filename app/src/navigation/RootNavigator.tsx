import React from 'react';
import { DarkTheme, DefaultTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { OnboardingScreen } from '../screens/OnboardingScreen';
import { ConversationListScreen } from '../screens/ConversationListScreen';
import { ConversationScreen } from '../screens/ConversationScreen';
import { BlockedPeersScreen } from '../screens/BlockedPeersScreen';
import { SettingsScreen } from '../screens/SettingsScreen';

export type RootStackParamList = {
  Onboarding: undefined;
  ConversationList: undefined;
  Conversation: { channelId: string; peerUserId: string };
  BlockedPeers: undefined;
  Settings: undefined;
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
    <NavigationContainer theme={navigationTheme}>
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
          options={{ title: t('navigation.conversationList') }}
        />
        <Stack.Screen name="Conversation" component={ConversationScreen} options={{ title: t('navigation.conversation') }} />
        <Stack.Screen
          name="BlockedPeers"
          component={BlockedPeersScreen}
          options={{ title: t('navigation.blockedPeers') }}
        />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: t('navigation.settings') }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
