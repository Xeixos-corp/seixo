import { ActionSheetIOS, Alert } from 'react-native';
import i18n from '../i18n';
import { registerIdentity } from '../identity/registerIdentity';
import { blockPeer } from '../transport/blocking';
import { sendReport, ReportLimitError } from '../transport/reports';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { hangUp, useCallStore } from './callManager';

/**
 * Report and Block, from inside a call (App Store guideline 1.2: a way to
 * report and to block abusive users, reachable where the abuse happens).
 *
 * A call leaves nothing to attach: the sound is never recorded and never
 * reaches the server readable. So this reports the account, the same way
 * "Report" in the conversation's menu does, with a line saying it was about a
 * call. Blocking hangs up first: nobody should have to stay on the line with
 * the person they are blocking.
 */

async function blockNow(peerUserId: string): Promise<void> {
  if (useCallStore.getState().peerUserId === peerUserId && useCallStore.getState().phase !== 'idle') hangUp();
  const { userId } = await registerIdentity();
  await blockPeer(userId, peerUserId);
  useBlockedPeersStore.getState().addBlockedPeer(peerUserId);
}

function confirmBlock(peerUserId: string): void {
  const t = i18n.t.bind(i18n);
  Alert.alert(t('call.blockConfirmTitle'), t('call.blockConfirmBody'), [
    { text: t('conversation.cancel'), style: 'cancel' },
    {
      text: t('conversation.confirmBlock'),
      style: 'destructive',
      onPress: () => {
        blockNow(peerUserId).catch((error) => {
          console.error('[callSafety] block failed', error);
          Alert.alert(t('conversation.blockFailed'));
        });
      },
    },
  ]);
}

function confirmReport(channelId: string, peerUserId: string): void {
  const t = i18n.t.bind(i18n);
  const send = async (alsoBlock: boolean) => {
    try {
      await sendReport({ channelId, reportedUserId: peerUserId, content: t('call.reportContent') });
      if (alsoBlock) await blockNow(peerUserId);
      Alert.alert(t('conversation.reportSentTitle'), t('conversation.reportSentBody'));
    } catch (error) {
      console.error('[callSafety] report failed', error);
      Alert.alert(error instanceof ReportLimitError ? t('conversation.reportLimit') : t('conversation.reportFailed'));
    }
  };
  Alert.alert(t('call.reportTitle'), t('call.reportBody'), [
    { text: t('conversation.cancel'), style: 'cancel' },
    { text: t('conversation.reportConfirm'), onPress: () => void send(false) },
    { text: t('conversation.reportAndBlock'), style: 'destructive', onPress: () => void send(true) },
  ]);
}

/** The "More" menu of a call: Report, Block. */
export function showCallSafetyMenu(channelId: string, peerUserId: string): void {
  const t = i18n.t.bind(i18n);
  ActionSheetIOS.showActionSheetWithOptions(
    {
      options: [t('conversation.reportButton'), t('conversation.blockButton'), t('conversation.cancel')],
      cancelButtonIndex: 2,
      destructiveButtonIndex: 1,
    },
    (index) => {
      if (index === 0) confirmReport(channelId, peerUserId);
      if (index === 1) confirmBlock(peerUserId);
    },
  );
}
