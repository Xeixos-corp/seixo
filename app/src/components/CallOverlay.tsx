import React, { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAppTheme } from '../theme/ThemeProvider';
import { useCallStore, acceptCall, declineCall, hangUp, toggleMute, toggleSpeaker } from '../calls/callManager';
import { useConversationsStore, conversationDisplayName } from '../store/conversationsStore';
import { HangUpIcon, MicOffIcon, MoreIcon, PhoneIcon, SpeakerIcon } from './icons';
import { showCallSafetyMenu } from '../calls/callSafety';
import { hasCallKit } from '../../modules/calls-expo/src';

/** 0:07, 12:34, 1:02:03. */
export function formatCallDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/**
 * The call screen, over everything else while a call is ringing or going on.
 *
 * Mounted inside the app lock (App.tsx), so a locked phone never shows who is
 * calling: it vibrates, and the call appears once the app is unlocked. CallKit
 * will show calls on the lock screen in a later phase, under the person's own
 * iOS settings.
 */
export function CallOverlay() {
  const { colors } = useAppTheme();
  const { t } = useTranslation();
  const phase = useCallStore((s) => s.phase);
  const channelId = useCallStore((s) => s.channelId);
  const peerUserId = useCallStore((s) => s.peerUserId);
  const connectedAt = useCallStore((s) => s.connectedAt);
  const muted = useCallStore((s) => s.muted);
  const speaker = useCallStore((s) => s.speaker);
  const endedReason = useCallStore((s) => s.endedReason);
  const conversation = useConversationsStore((s) => s.conversations.find((c) => c.channelId === channelId));
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (phase !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  // With CallKit, a ringing call is iOS's own screen (lock screen, banner);
  // this one takes over once the call is answered.
  const visible = (phase !== 'idle' || endedReason !== null) && !(hasCallKit && phase === 'incoming');
  if (!visible) return null;

  const name = conversation ? conversationDisplayName(conversation) : '';
  const status =
    phase === 'idle'
      ? t(`call.ended.${endedReason ?? 'ended'}`)
      : phase === 'outgoing'
        ? t('call.calling')
        : phase === 'incoming'
          ? t('call.incoming')
          : phase === 'connecting'
            ? t('call.connecting')
            : formatCallDuration(Math.max(0, Math.round((now - (connectedAt ?? now)) / 1000)));

  return (
    <Modal visible animationType="fade" presentationStyle="fullScreen" onRequestClose={hangUp}>
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Report and Block, where an abusive call is happening. */}
        {phase !== 'idle' && channelId && peerUserId ? (
          <Pressable
            style={styles.more}
            onPress={() => showCallSafetyMenu(channelId, peerUserId)}
            hitSlop={12}
            accessibilityRole="button"
            accessibilityLabel={t('conversation.moreButton')}
          >
            <MoreIcon size={26} color={colors.textSecondary} />
          </Pressable>
        ) : null}
        <View style={styles.top}>
          <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
            {name}
          </Text>
          <Text style={[styles.status, { color: colors.textSecondary }]}>{status}</Text>
          <Text style={[styles.note, { color: colors.textSecondary }]}>{t('call.encryptedNote')}</Text>
        </View>

        {phase === 'incoming' ? (
          <View style={styles.row}>
            <RoundButton
              label={t('call.decline')}
              background={colors.danger}
              onPress={declineCall}
              icon={<HangUpIcon size={30} color="#FFFFFF" />}
            />
            <RoundButton
              label={t('call.accept')}
              background={colors.success}
              onPress={() => void acceptCall()}
              icon={<PhoneIcon size={28} color="#FFFFFF" />}
            />
          </View>
        ) : phase !== 'idle' ? (
          <View style={styles.bottom}>
            <View style={styles.row}>
              <RoundButton
                label={muted ? t('call.unmute') : t('call.mute')}
                background={muted ? colors.textPrimary : colors.surfaceAlt}
                onPress={toggleMute}
                icon={<MicOffIcon size={26} color={muted ? colors.background : colors.textPrimary} />}
              />
              <RoundButton
                label={t('call.speaker')}
                background={speaker ? colors.textPrimary : colors.surfaceAlt}
                onPress={toggleSpeaker}
                icon={<SpeakerIcon size={26} color={speaker ? colors.background : colors.textPrimary} />}
              />
            </View>
            <RoundButton
              label={t('call.hangUp')}
              background={colors.danger}
              onPress={hangUp}
              icon={<HangUpIcon size={30} color="#FFFFFF" />}
            />
          </View>
        ) : (
          <View style={styles.bottom} />
        )}
      </SafeAreaView>
    </Modal>
  );
}

function RoundButton({
  label,
  background,
  icon,
  onPress,
}: {
  label: string;
  background: string;
  icon: React.ReactNode;
  onPress: () => void;
}) {
  const { colors } = useAppTheme();
  return (
    <View style={styles.buttonWrap}>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={label}
        style={({ pressed }) => [styles.button, { backgroundColor: background, opacity: pressed ? 0.7 : 1 }]}
      >
        {icon}
      </Pressable>
      <Text style={[styles.buttonLabel, { color: colors.textSecondary }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'space-between', paddingHorizontal: 24 },
  top: { alignItems: 'center', marginTop: 72 },
  more: { position: 'absolute', top: 56, right: 24, zIndex: 1 },
  name: { fontSize: 30, fontWeight: '600', marginBottom: 10 },
  status: { fontSize: 17, fontVariant: ['tabular-nums'] },
  note: { fontSize: 12, marginTop: 18, textAlign: 'center' },
  bottom: { alignItems: 'center', gap: 32, marginBottom: 48 },
  row: { flexDirection: 'row', justifyContent: 'space-evenly', alignSelf: 'stretch', marginBottom: 48 },
  buttonWrap: { alignItems: 'center', width: 96 },
  button: { width: 72, height: 72, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  buttonLabel: { fontSize: 13, marginTop: 8, textAlign: 'center' },
});
