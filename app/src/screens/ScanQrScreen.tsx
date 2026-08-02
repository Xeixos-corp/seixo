import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useTranslation } from 'react-i18next';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppTheme } from '../theme/ThemeProvider';
import { startConversationWithPeer, SelfConversationError } from '../identity/startConversation';
import { isBlockedChannelError } from '../transport/blocking';
import { isUntrustedIdentityError } from '../crypto';
import type { RootStackParamList } from '../navigation/RootNavigator';

type Props = NativeStackScreenProps<RootStackParamList, 'ScanQr'>;

// A scanned QR only makes sense here if it's shaped like the user_id
// (uuid) MyIdCard.tsx encodes — rejects unrelated QR codes (a URL, a wifi
// QR, someone else's app) before ever treating the payload as a peer id.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function ScanQrScreen({ navigation }: Props) {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const [starting, setStarting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleBarcodeScanned = async ({ data }: BarcodeScanningResult) => {
    if (scanned || starting) return;
    const peerUserId = data.trim();
    if (!UUID_PATTERN.test(peerUserId)) return;

    setScanned(true);
    setStarting(true);
    setErrorMessage(null);
    try {
      const conversation = await startConversationWithPeer(peerUserId);
      navigation.replace('Conversation', conversation);
    } catch (error) {
      if (error instanceof SelfConversationError) {
        setErrorMessage(t('conversationList.selfConversationError'));
      } else if (isUntrustedIdentityError(error)) {
        setErrorMessage(t('conversationList.untrustedIdentityError', { peerId: peerUserId }));
      } else if (isBlockedChannelError(error)) {
        setErrorMessage(t('conversationList.blockedChannelError'));
      } else {
        setErrorMessage(error instanceof Error ? error.message : String(error));
      }
      setStarting(false);
      setScanned(false);
    }
  };

  if (!permission) {
    return <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} />;
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.permissionText, { color: colors.textSecondary }]}>
          {t('scanQr.permissionDenied')}
        </Text>
        {permission.canAskAgain ? (
          <Text
            style={[styles.permissionLink, { color: colors.accent }]}
            onPress={requestPermission}
          >
            {t('scanQr.requestPermission')}
          </Text>
        ) : null}
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.cameraWrapper}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
        />
      </View>
      <View style={styles.footer}>
        {starting ? <ActivityIndicator color={colors.accent} /> : null}
        {errorMessage ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{errorMessage}</Text>
        ) : (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('scanQr.hint')}</Text>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  permissionText: {
    fontSize: 15,
    textAlign: 'center',
    lineHeight: 20,
  },
  permissionLink: {
    fontSize: 15,
    fontWeight: '600',
  },
  cameraWrapper: {
    flex: 1,
    margin: 16,
    borderRadius: 16,
    overflow: 'hidden',
  },
  camera: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: 16,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  hint: {
    fontSize: 14,
    textAlign: 'center',
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
  },
});
