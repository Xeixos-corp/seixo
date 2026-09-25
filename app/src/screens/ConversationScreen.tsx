import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Animated,
  AppState,
  FlatList,
  Image,
  Modal,
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useKeyboardSpacer } from '../hooks/useKeyboardSpacer';
import { useAppTheme } from '../theme/ThemeProvider';
import { useMessagesStore, type DecryptedMessage } from '../store/messagesStore';
import {
  useConversationsStore,
  conversationDisplayName,
  peerNickname,
  DEFAULT_TTL_SECONDS,
} from '../store/conversationsStore';
import { useBlockedPeersStore } from '../store/blockedPeersStore';
import { fetchMessages, sendMessage, deleteMessage } from '../transport/messages';
import { ingestFetchedMessage } from '../messaging/ingest';
import { encodePayload } from '../messaging/payload';
import { splitLinks } from '../messaging/links';
import { useSecurityWarningsStore } from '../store/securityWarningsStore';
import { setActiveConversation } from '../messaging/activeConversation';
import { SafetyNumberCard } from '../components/SafetyNumberCard';
import { getCurrentUserId } from '../identity/currentUser';
import { sendGroupMessage, EmptyGroupError } from '../messaging/sendToGroup';
import {
  addGroupMember,
  removeGroupMember,
  fetchChannelMembers,
  deleteGroupChannel,
  leaveChannel,
} from '../transport/channels';
import {
  AudioModule,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import {
  iosRecorderOptions,
  MAX_VOICE_DURATION_MS,
  VOICE_SERVER_TTL_SECONDS,
} from '../audio/recordingOptions';
import { readRecordingAndDelete } from '../audio/voiceFiles';
import {
  configureForRecording,
  configureForPlayback,
  onAudioInterruption,
} from '../../modules/audio-session-expo/src';
import { VoiceMessage } from '../components/VoiceMessage';
import { ImageMessage } from '../components/ImageMessage';
import { ImageIcon } from '../components/icons';
import {
  IMAGE_SERVER_TTL_SECONDS,
  ImageMetadataError,
  keepOwnCopy,
  pickImage,
  prepareImage,
  sealImage,
  uploadSealed,
} from '../messaging/attachments';
import * as Clipboard from 'expo-clipboard';
import * as ScreenCapture from 'expo-screen-capture';
import { blockPeer } from '../transport/blocking';
import { registerIdentity } from '../identity/registerIdentity';
import { encryptMessage, isUntrustedIdentityError } from '../crypto';
import { sendReport, ReportLimitError, isAccountRestrictedError } from '../transport/reports';
import { isObjectionable } from '../messaging/contentFilter';
import type { RootStackParamList } from '../navigation/RootNavigator';
import { discardSharedImage, type SharedImage } from '../store/pendingShareStore';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

const REMOTE_DEVICE_ID = 1; // single device per identity for now

// Stable reference for "this channel has no messages yet". Returning a fresh
// `[]` from the selector below instead would hand React a different snapshot
// on every render: useSyncExternalStore (which zustand v5 is built on)
// treats that as the store having changed, re-renders, gets another new
// array, and throws "The result of getSnapshot should be cached to avoid an
// infinite loop". That error escapes to the root and unmounts the entire
// app -- a completely white screen, no header, no error text.
//
// It only bites on channels with no decrypted messages, i.e. exactly when
// opening a conversation you just started, which is why it survived until
// someone actually tried to chat.
// A short, fixed set. A full emoji keyboard turns a one-tap gesture into a
// search, and these six cover almost everything people actually use.
const REACTION_EMOJIS = ['❤️', '👍', '😂', '😮', '😢', '🙏'];

/**
 * What to show for a quoted message. A voice message has no text at all, so
 * quoting one used to render an empty line -- looking like a bug rather than
 * a quote.
 */
function quotePreview(message: DecryptedMessage | undefined, t: TFunction): string {
  if (!message) return t('conversation.quoteUnavailable');
  if (message.audioBase64) return t('conversation.voiceMessage');
  if (message.image) return t('conversation.imageQuote');
  return message.plaintext;
}

const NO_MESSAGES: DecryptedMessage[] = [];

const TTL_OPTIONS: Array<{ key: string; seconds: number }> = [
  { key: '30s', seconds: 30 },
  { key: '5min', seconds: 5 * 60 },
  { key: '1hour', seconds: 60 * 60 },
  { key: '1day', seconds: 24 * 60 * 60 },
  { key: '1week', seconds: 7 * 24 * 60 * 60 },
];

/**
 * How long until this message disappears, in coarse units. Deliberately
 * approximate: the countdown is reassurance that the timer is real, not a
 * precision instrument — the actual removal is driven by scheduleExpiry and
 * the server-side purge, not by this label.
 */
function formatTimeLeft(expiresAt: string, now: number, t: TFunction): string {
  const msLeft = new Date(expiresAt).getTime() - now;
  const seconds = Math.max(0, Math.round(msLeft / 1000));

  if (seconds < 60) return t('conversation.expiresInSeconds', { count: seconds });
  if (seconds < 60 * 60) return t('conversation.expiresInMinutes', { count: Math.round(seconds / 60) });
  if (seconds < 24 * 60 * 60) return t('conversation.expiresInHours', { count: Math.round(seconds / 3600) });
  return t('conversation.expiresInDays', { count: Math.round(seconds / 86400) });
}

/**
 * Clock time for today's messages, date + time for older ones. Uses the
 * device locale rather than the app's chosen language: this is a timestamp,
 * and people read those in the format their phone is set to.
 */
function formatSentAt(createdAt: string): string {
  const sent = new Date(createdAt);
  const sameDay = new Date().toDateString() === sent.toDateString();
  return sameDay
    ? sent.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : sent.toLocaleString(undefined, {
        day: '2-digit',
        month: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
}

export function ConversationScreen({ route, navigation }: Props) {
  const { channelId, peerUserId, initialDraft, initialImage } = route.params;
  const { colors } = useAppTheme();
  const keyboardSpacer = useKeyboardSpacer();
  const { t } = useTranslation();
  const messages = useMessagesStore((state) => state.messagesByChannel[channelId] ?? NO_MESSAGES);

  // Newest first, because the list below is `inverted`.
  //
  // Sorting is not cosmetic: messages are stored in the order they were
  // ingested, which is not the order they were sent. A realtime insert can
  // land while a catch-up fetch is still resolving, so without this an older
  // message can appear after a newer one.
  const orderedMessages = useMemo(
    () =>
      messages
        // Edits and reactions are stored only so their ids are remembered;
        // they are instructions, not things to read.
        .filter((message) => message.isControl !== true)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
    [messages],
  );
  const addMessage = useMessagesStore((state) => state.addMessage);
  const replaceMessage = useMessagesStore((state) => state.replaceMessage);
  const setMessageStatus = useMessagesStore((state) => state.setMessageStatus);
  const updateMessageImage = useMessagesStore((state) => state.updateMessageImage);
  const applyEdit = useMessagesStore((state) => state.applyEdit);
  const removeMessage = useMessagesStore((state) => state.removeMessage);
  const ttlSeconds = useConversationsStore(
    (state) => state.conversations.find((c) => c.channelId === channelId)?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
  );
  const setConversationTtl = useConversationsStore((state) => state.setConversationTtl);
  const conversation = useConversationsStore((state) =>
    state.conversations.find((item) => item.channelId === channelId),
  );
  const isGroup = conversation?.isGroup === true;
  const groupMemberIds = conversation?.memberIds;
  // Returns a string, so this selector compares by value and stays stable.
  const conversationName = useConversationsStore((state) => {
    const conversation = state.conversations.find((c) => c.channelId === channelId);
    return conversation
      ? conversationDisplayName(conversation, t('conversationList.unnamedGroup'))
      : `${peerUserId.slice(0, 8)}…`;
  });
  // The list rather than the `isBlocked` function, so the members sheet
  // updates as soon as someone is blocked -- see ConversationListScreen.
  const blockedPeerIds = useBlockedPeersStore((state) => state.blockedPeerIds);
  // Needed to put a name to each member of a group; nicknames live on the
  // direct conversation with that person.
  const allConversations = useConversationsStore((state) => state.conversations);
  const addBlockedPeer = useBlockedPeersStore((state) => state.addBlockedPeer);
  const markConversationRead = useConversationsStore((state) => state.markConversationRead);

  const handleBlock = useCallback(() => {
    Alert.alert(
      t('conversation.blockConfirmTitle'),
      t('conversation.blockConfirmMessage', { peerId: peerUserId }),
      [
        { text: t('conversation.cancel'), style: 'cancel' },
        {
          text: t('conversation.confirmBlock'),
          style: 'destructive',
          onPress: async () => {
            try {
              const { userId } = await registerIdentity();
              await blockPeer(userId, peerUserId);
              addBlockedPeer(peerUserId);
              // Deliberately NOT removing the conversation. The list already
              // filters out blocked peers, so removing it as well destroyed
              // the only local record of the channel -- and unblocking could
              // then never bring it back, because the app learns about
              // channels from new-membership events and there is no new
              // membership to hear about. Hiding is reversible; deleting was
              // not.
              navigation.navigate('ConversationList');
            } catch (error) {
              // Loudly. This used to only reach the console, so a block that
              // never reached the server looked exactly like one that worked:
              // the conversation stayed put and nothing said why. Being told
              // you blocked someone when you did not is the worst possible
              // outcome for this particular button.
              console.error('[ConversationScreen] failed to block peer', error);
              setSendError(t('conversation.blockFailed'));
            }
          },
        },
      ],
    );
  }, [peerUserId, channelId, addBlockedPeer, navigation, t]);

  /**
   * Leaving a group, which is what "block" cannot be for one.
   *
   * A group has no peer: peerUserId is the empty string for it (see the
   * reconciliation in registerIdentity). The block button offered on one read
   * "you will no longer be able to exchange messages with ." and, if pressed,
   * sent that empty id to the server and failed. Leaving is the honest
   * equivalent, and until now it existed only in the conversation list.
   *
   * Only this device leaves. The group carries on without it, which is why
   * the wording says so -- nobody should press this thinking it ends the
   * group for everyone. That is a separate thing, and only its owner can.
   */
  const handleLeaveGroup = useCallback(() => {
    Alert.alert(t('conversation.leaveGroupTitle'), t('conversation.leaveGroupBody'), [
      { text: t('conversation.cancel'), style: 'cancel' },
      {
        text: t('conversation.leaveGroupConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            const { userId } = await registerIdentity();
            await leaveChannel(channelId, userId);
            useMessagesStore.getState().clearChannel(channelId);
            useConversationsStore.getState().removeConversation(channelId);
            navigation.navigate('ConversationList');
          } catch (error) {
            console.error('[ConversationScreen] failed to leave group', error);
            setSendError(t('conversation.leaveGroupFailed'));
          }
        },
      },
    ]);
  }, [channelId, navigation, t]);

  /**
   * Sends a report to the developer (transport/reports.ts), who is emailed at
   * once and decides within a day whether to expel the account.
   *
   * It used to open a pre-written email instead, which needed a mail account
   * on the phone and ended in a draft the person might never send. App
   * Review asked for a mechanism to flag content (Guideline 1.2); this one
   * says "sent" and means it.
   */
  const submitReport = useCallback(
    async (reportedUserId: string, message?: DecryptedMessage, alsoBlock?: () => Promise<void>) => {
      try {
        await sendReport({
          channelId,
          reportedUserId,
          messageId: message?.id,
          // What the reporter chose to show. A photo or a recording is named,
          // not sent: the report carries text only.
          content: message
            ? message.image
              ? t('conversation.reportPhotoPlaceholder')
              : message.audioBase64
                ? t('conversation.reportVoicePlaceholder')
                : message.plaintext
            : undefined,
        });
        if (alsoBlock) await alsoBlock();
        Alert.alert(t('conversation.reportSentTitle'), t('conversation.reportSentBody'));
      } catch (error) {
        console.error('[ConversationScreen] failed to send report', error);
        setSendError(
          error instanceof ReportLimitError ? t('conversation.reportLimit') : t('conversation.reportFailed'),
        );
      }
    },
    [channelId, t],
  );

  const blockPeerNow = useCallback(async () => {
    const { userId } = await registerIdentity();
    await blockPeer(userId, peerUserId);
    addBlockedPeer(peerUserId);
    navigation.navigate('ConversationList');
  }, [peerUserId, addBlockedPeer, navigation]);

  const handleReport = useCallback(() => {
    // A group has no single person to report from the header; the report
    // belongs on the message, which names its sender.
    if (isGroup) {
      Alert.alert(t('conversation.reportTitle'), t('conversation.reportGroupHint'));
      return;
    }
    Alert.alert(t('conversation.reportPersonTitle'), t('conversation.reportPersonBody'), [
      { text: t('conversation.cancel'), style: 'cancel' },
      { text: t('conversation.reportConfirm'), onPress: () => void submitReport(peerUserId) },
      {
        text: t('conversation.reportAndBlock'),
        style: 'destructive',
        onPress: () => void submitReport(peerUserId, undefined, blockPeerNow),
      },
    ]);
  }, [isGroup, peerUserId, submitReport, blockPeerNow, t]);

  const handleReportMessage = useCallback(
    (message: DecryptedMessage) => {
      const reportedUserId = isGroup ? message.senderUserId : peerUserId;
      if (!reportedUserId) return;
      Alert.alert(t('conversation.reportMessageTitle'), t('conversation.reportMessageBody'), [
        { text: t('conversation.cancel'), style: 'cancel' },
        { text: t('conversation.reportConfirm'), onPress: () => void submitReport(reportedUserId, message) },
        ...(isGroup
          ? []
          : [
              {
                text: t('conversation.reportAndBlock'),
                style: 'destructive' as const,
                onPress: () => void submitReport(reportedUserId, message, blockPeerNow),
              },
            ]),
      ]);
    },
    [isGroup, peerUserId, submitReport, blockPeerNow, t],
  );

  useEffect(() => {
    navigation.setOptions({
      title: conversationName,
      headerRight: () => (
        <View style={styles.headerButtons}>
          {isGroup ? (
            <Pressable onPress={() => setShowMembers(true)} hitSlop={8}>
              <Text style={{ color: colors.accent, fontSize: 13 }}>
                {t('conversation.membersButton')}
              </Text>
            </Pressable>
          ) : (
            <Pressable onPress={() => setShowSafetyNumber(true)} hitSlop={8}>
              <Text style={{ color: colors.accent, fontSize: 13 }}>
                {t('conversation.verifyButton')}
              </Text>
            </Pressable>
          )}
          <Pressable onPress={handleReport} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 13 }}>{t('conversation.reportButton')}</Text>
          </Pressable>
          <Pressable onPress={isGroup ? handleLeaveGroup : handleBlock} hitSlop={8}>
            <Text style={{ color: colors.danger, fontSize: 13 }}>
              {isGroup ? t('conversation.leaveGroupButton') : t('conversation.blockButton')}
            </Text>
          </Pressable>
        </View>
      ),
    });
  }, [
    navigation,
    colors.accent,
    colors.danger,
    handleBlock,
    handleLeaveGroup,
    handleReport,
    isGroup,
    t,
    conversationName,
  ]);

  // Drives the per-message countdown labels. Coarse on purpose (10s): the
  // label only needs to be roughly right, and the actual disappearance is
  // handled by scheduleExpiry, not by this.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(tick);
  }, []);

  // Received messages the filter covered and the person chose to see. Kept
  // for this visit only: coming back covers them again, which is the safer
  // default for words someone might not want on screen twice.
  const [revealedIds, setRevealedIds] = useState<Set<string>>(() => new Set());
  const [inputText, setInputText] = useState(initialDraft ?? '');
  // Also when this screen is reused with new params rather than mounted
  // afresh, which the navigator may do; useState's initial value would
  // otherwise keep the old, empty draft.
  useEffect(() => {
    if (initialDraft) setInputText(initialDraft);
  }, [initialDraft]);

  // A photo shared from another app, waiting above the input box for the
  // person to send or discard. Until then it is the extension's untouched
  // copy -- the original, location and all -- so every way of letting go of
  // it deletes it, including leaving the conversation without deciding.
  const [sharedImage, setSharedImage] = useState<SharedImage | null>(initialImage ?? null);
  const sharedImageRef = useRef<SharedImage | null>(sharedImage);
  const replaceSharedImage = useCallback((next: SharedImage | null) => {
    if (sharedImageRef.current && sharedImageRef.current.uri !== next?.uri) {
      discardSharedImage(sharedImageRef.current);
    }
    sharedImageRef.current = next;
    setSharedImage(next);
  }, []);
  useEffect(() => {
    if (initialImage) replaceSharedImage(initialImage);
  }, [initialImage, replaceSharedImage]);
  useEffect(() => () => discardSharedImage(sharedImageRef.current), []);
  const [sending, setSending] = useState(false);
  // Sending used to fail silently: the catch below only wrote to the
  // console, so pressing send with no connection did visibly nothing at
  // all. "I don't know whether that sent" is about the worst state a
  // messenger can leave someone in.
  const [sendError, setSendError] = useState<string | null>(null);
  // Says a copy happened. iOS gives no feedback of its own for the clipboard,
  // and a silent menu item leaves you wondering whether it worked.
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * Puts text on the clipboard and says so.
   *
   * Worth being clear-eyed about what this is: the clipboard belongs to the
   * whole phone, not to this app. Anything put there can be read by any other
   * app the person opens next, and iOS syncs it to their other Apple devices.
   * It is also a way out of the disappearing-message timer -- text copied out
   * survives the message it came from.
   *
   * It is offered anyway, because people copy an address or a code out of a
   * message constantly, and the alternative they are left with otherwise is
   * retyping it by hand or taking a screenshot, which is worse on both counts.
   * The FAQ says what leaving the app costs; this is the same bargain,
   * made deliberately.
   */
  const copyToClipboard = useCallback(
    async (text: string, confirmation: string) => {
      try {
        await Clipboard.setStringAsync(text);
        setNotice(confirmation);
        setTimeout(() => setNotice(null), 2000);
      } catch (error) {
        console.error('[ConversationScreen] failed to copy', error);
        setSendError(t('conversation.copyFailed'));
      }
    },
    [t],
  );

  const [replyToId, setReplyToId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showSafetyNumber, setShowSafetyNumber] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  // Feedback for actions taken inside the members sheet. It needs its own
  // state because the sheet covers the conversation, where sendError is drawn.
  const [membersNotice, setMembersNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(
    null,
  );
  const [newMemberId, setNewMemberId] = useState('');
  const [groupNameDraft, setGroupNameDraft] = useState('');
  /**
   * A shorter timer for the next message only, chosen without changing the
   * conversation's own. For an address, a code, a password -- the things
   * people want gone quickly without renegotiating the whole conversation
   * and then remembering to set it back.
   */
  const [oneOffTtlSeconds, setOneOffTtlSeconds] = useState<number | null>(null);
  const [recording, setRecording] = useState(false);
  // Seconds elapsed, ticked while recording. Without it there is no way to
  // tell a recording that started from one that didn't, nor how close it is
  // to the one-minute ceiling.
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const recordingStartedAt = useRef(0);
  // Created only while recording, and destroyed straight after. useAudioRecorder
  // would build one the moment this screen mounts, and on iOS merely having a
  // recorder puts the audio session into a record-and-play mode that routes
  // playback away from Bluetooth -- so voice messages played to silence on
  // AirPods even in a conversation where nothing was ever recorded.
  const recorderRef = useRef<InstanceType<typeof AudioModule.AudioRecorder> | null>(null);
  const listRef = useRef<FlatList<DecryptedMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Set when establishSession/encrypt/decrypt fails because the peer's
  // identity key changed since the last session (see
  // crypto/index.ts::isUntrustedIdentityError) — the equivalent of Signal's
  // "safety number changed" warning. Distinct from loadError/console.error
  // below: without this, a changed identity used to fail completely
  // silently (no UI signal at all that something needs attention).
  // Recorded by messaging/ingest.ts, which decrypts wherever the user happens
  // to be -- so the screen can no longer be the thing that notices.
  const untrusted = useSecurityWarningsStore(
    (state) => state.untrustedByChannel[channelId] === true,
  );
  const clearUntrusted = useSecurityWarningsStore((state) => state.clearUntrusted);
  const [sendSecurityWarning, setSendSecurityWarning] = useState<string | null>(null);
  const securityWarning = untrusted
    ? t('conversation.securityWarningDecrypt', { peerId: peerUserId })
    : sendSecurityWarning;

  // Local-side disappearing-message timers, keyed by message id, so we can
  // cancel them on unmount instead of leaking setTimeouts. This runs
  // alongside — not instead of — the server-side pg_cron purge; it's what
  // makes an expired message disappear from an already-open conversation
  // screen without waiting for a re-fetch.
  const expiryTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const scheduleExpiry = useCallback(
    (id: string, expiresAt: string) => {
      const delayMs = new Date(expiresAt).getTime() - Date.now();
      if (delayMs <= 0) {
        removeMessage(channelId, id);
        return;
      }
      const timer = setTimeout(() => {
        removeMessage(channelId, id);
        expiryTimers.current.delete(id);
      }, delayMs);
      expiryTimers.current.set(id, timer);
    },
    [channelId, removeMessage],
  );

  useEffect(() => {
    const timers = expiryTimers.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, [channelId]);

  // Messages restored from disk (messagesStore is persisted) never went
  // through decryptAndStore/handleSend on this launch, so nothing scheduled
  // their expiry. Without this, reopening the app would leave a message with
  // a 30-second timer sitting on screen indefinitely — the disappearing
  // timer would silently only work within a single session.
  //
  // Safe to run on every messages change: scheduleExpiry is keyed by id and
  // guarded here against double-scheduling, and it removes anything already
  // past its expiry immediately.
  useEffect(() => {
    messages.forEach((message) => {
      if (!expiryTimers.current.has(message.id)) {
        scheduleExpiry(message.id, message.expiresAt);
      }
    });
  }, [messages, scheduleExpiry]);

  // Drop a message locally and cancel its pending expiry timer. Used both
  // when this user deletes one and when the peer's deletion arrives over
  // realtime -- without clearing the timer, it would fire later against an
  // id that no longer exists.
  const dropMessage = useCallback(
    (messageId: string) => {
      const timer = expiryTimers.current.get(messageId);
      if (timer) {
        clearTimeout(timer);
        expiryTimers.current.delete(messageId);
      }
      removeMessage(channelId, messageId);
    },
    [channelId, removeMessage],
  );

  /**
   * The one place that knows whether this conversation has one recipient or
   * several. Every send -- text, voice, reaction, edit -- goes through here,
   * so none of them has to repeat the decision or risk getting it wrong.
   */
  const transmit = useCallback(
    async (
      payload: string,
      {
        lifetimeSeconds = ttlSeconds,
        ...options
      }: {
        silent?: boolean;
        serverTtlSeconds?: number;
        /** Instead of the conversation's timer -- for a deletion, see below. */
        lifetimeSeconds?: number;
      } = {},
    ) => {
      try {
      if (isGroup) {
        const selfUserId = getCurrentUserId();
        if (!selfUserId) throw new Error('Group membership not loaded yet');
        // Ask the server rather than give up. The local list can be empty or
        // stale -- a group opened straight from a notification, say -- and
        // refusing to send in that case made group actions do nothing at all,
        // with the reason rendered on a screen hidden behind the members
        // sheet. Fetching costs one request and only happens when the list is
        // missing.
        let members = groupMemberIds;
        if (!members?.length) {
          members = await fetchChannelMembers(channelId);
          // Read off the store rather than the hook binding: that one is
          // declared below this callback, and hoisting a dependency just to
          // satisfy the order is how this file has broken three times.
          useConversationsStore.getState().setGroupMembers(channelId, members);
        }
        if (!members.length) throw new Error('Group membership not loaded yet');
        return sendGroupMessage(
          channelId,
          selfUserId,
          members,
          payload,
          lifetimeSeconds,
          options,
        );
      }
      const envelope = encryptMessage(peerUserId, REMOTE_DEVICE_ID, payload);
      return sendMessage(channelId, envelope, lifetimeSeconds, options);
      } catch (error) {
        // Every send goes through here, so this is the one place to say why
        // an account that was suspended or expelled can no longer send --
        // rather than leaving it with a row of silent "not sent" marks.
        if (isAccountRestrictedError(error)) setSendError(t('conversation.accountRestricted'));
        throw error;
      }
    },
    [isGroup, groupMemberIds, channelId, peerUserId, ttlSeconds, t],
  );

  const sendVoiceMessage = useCallback(
    async (
      audioBase64: string,
      durationMs: number,
      /** A failed voice message being sent again, in its own place. */
      retryOfLocalId?: string,
    ) => {
      const localId = retryOfLocalId ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      if (retryOfLocalId) {
        setMessageStatus(channelId, localId, 'sending');
      } else {
        addMessage(channelId, {
          id: localId,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
          plaintext: '',
          isMine: true,
          status: 'sending',
          audioBase64,
          audioDurationMs: durationMs,
        });
      }

      try {
        const { id, createdAt, expiresAt } = await transmit(
          encodePayload({
            text: '',
            audioBase64,
            audioDurationMs: durationMs,
            // The device lifetime rides inside the encryption, because the
            // server's copy is capped at a day no matter what was chosen.
            localTtlSeconds: ttlSeconds,
          }),
          { serverTtlSeconds: VOICE_SERVER_TTL_SECONDS },
        );
        replaceMessage(channelId, localId, {
          id,
          createdAt,
          // Deliberately not the row's expires_at: that is the server's
          // waiting-room deadline, not how long this message should live here.
          expiresAt: new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString(),
          plaintext: '',
          isMine: true,
          status: 'sent',
          audioBase64,
          audioDurationMs: durationMs,
        });
        scheduleExpiry(id, new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString());
      } catch (error) {
        setMessageStatus(channelId, localId, 'failed');
        console.error('[ConversationScreen] failed to send voice message', error);
      }
    },
    [channelId, transmit, ttlSeconds, addMessage, replaceMessage, setMessageStatus, scheduleExpiry],
  );

  /**
   * Sends a photo already chosen -- from the picker, or shared from another
   * app: strips it, seals it, then inserts the message and uploads the sealed
   * file under that message's id. The file it is given is deleted either way
   * (the re-encode deletes its source).
   *
   * The order is fixed by the server. The storage policy only accepts an
   * object whose message already exists, so the message goes first and the
   * upload follows; the other phone may see the message a moment before the
   * picture is there, and waits for it (messaging/attachments.ts).
   *
   * Everything that can fail before the message exists fails quietly back to
   * the conversation with a reason and nothing sent. Once the message exists,
   * a failed upload is shown on the picture itself rather than hidden.
   */
  const sendPickedImage = useCallback(
    async (picked: { uri: string; width: number; height: number }) => {
      setSendError(null);

      let prepared: Awaited<ReturnType<typeof prepareImage>>;
      let sealed: Awaited<ReturnType<typeof sealImage>>;
      let fileName: string;
      try {
        prepared = await prepareImage(picked);
        // Sealed before the copy is kept: keeping it moves the file.
        sealed = await sealImage(prepared.uri);
        fileName = await keepOwnCopy(prepared.uri);
      } catch (error) {
        console.error('[ConversationScreen] could not prepare the image', error);
        setSendError(
          error instanceof ImageMetadataError
            ? t('conversation.imageMetadataRefused')
            : t('conversation.imagePrepareFailed'),
        );
        return;
      }

      const shown = {
        width: prepared.width,
        height: prepared.height,
        previewBase64: prepared.previewBase64,
        fileName,
      };
      const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      addMessage(channelId, {
        id: localId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
        plaintext: '',
        isMine: true,
        status: 'sending',
        image: { ...shown, state: 'uploading' },
      });

      let messageId: string;
      try {
        const { id, createdAt } = await transmit(
          encodePayload({
            // Only for builds that predate images, which would otherwise show
            // an empty bubble. Newer ones draw the picture and ignore this.
            text: t('conversation.imageFallback'),
            image: {
              keyBase64: sealed.keyBase64,
              width: prepared.width,
              height: prepared.height,
              previewBase64: prepared.previewBase64,
            },
            // The lifetime on the phones rides inside the encryption; the
            // server's copy is capped at a day whatever was chosen.
            localTtlSeconds: ttlSeconds,
          }),
          { serverTtlSeconds: IMAGE_SERVER_TTL_SECONDS },
        );
        messageId = id;
        const expiresAt = new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString();
        replaceMessage(channelId, localId, {
          id,
          createdAt,
          expiresAt,
          plaintext: '',
          isMine: true,
          status: 'sent',
          image: { ...shown, state: 'uploading' },
        });
        scheduleExpiry(id, expiresAt);
      } catch (error) {
        console.error('[ConversationScreen] failed to send image message', error);
        setMessageStatus(channelId, localId, 'failed');
        updateMessageImage(channelId, localId, { state: 'failed' });
        return;
      }

      try {
        await uploadSealed(messageId, sealed.sealedUri);
        updateMessageImage(channelId, messageId, { state: undefined });
      } catch (error) {
        // The message is out there and will show the other side a picture it
        // cannot fetch -- which their app reports as unavailable after its
        // retries. Said here too, so the sender is not the last to know.
        console.error('[ConversationScreen] failed to upload image', error);
        updateMessageImage(channelId, messageId, { state: 'failed' });
      }
    },
    [
      channelId,
      transmit,
      ttlSeconds,
      addMessage,
      replaceMessage,
      setMessageStatus,
      updateMessageImage,
      scheduleExpiry,
      t,
    ],
  );

  /** Takes a photo, or lets the person choose one, and sends it. */
  const sendImage = useCallback(
    async (source: 'camera' | 'library') => {
      setSendError(null);

      let picked: Awaited<ReturnType<typeof pickImage>>;
      try {
        picked = await pickImage(source);
      } catch (error) {
        console.error('[ConversationScreen] could not open the picker', error);
        setSendError(t('conversation.imagePickFailed'));
        return;
      }
      if (picked.kind === 'cancelled') return;
      if (picked.kind === 'denied') {
        if (!picked.canAskAgain) {
          // Same rule as the microphone: the way to Settings is offered only
          // after an earlier refusal, never in answer to one just given.
          Alert.alert(t('permissions.cameraBlockedTitle'), t('permissions.cameraBlockedBody'), [
            { text: t('conversation.cancel'), style: 'cancel' },
            { text: t('permissions.openSettings'), onPress: () => void Linking.openSettings() },
          ]);
        } else {
          setSendError(t('conversation.cameraDenied'));
        }
        return;
      }
      await sendPickedImage(picked);
    },
    [sendPickedImage, t],
  );

  const sendSharedImage = useCallback(() => {
    const image = sharedImageRef.current;
    if (!image) return;
    // Handed over before sending, so the cleanup above does not delete the
    // file the send is still reading. The send deletes it itself.
    sharedImageRef.current = null;
    setSharedImage(null);
    void sendPickedImage(image);
  }, [sendPickedImage]);

  const chooseImageSource = useCallback(() => {
    Alert.alert(t('conversation.attachTitle'), undefined, [
      { text: t('conversation.attachCamera'), onPress: () => void sendImage('camera') },
      { text: t('conversation.attachLibrary'), onPress: () => void sendImage('library') },
      { text: t('conversation.cancel'), style: 'cancel' },
    ]);
  }, [sendImage, t]);

  const startRecording = useCallback(async () => {
    // Checked before asking, to tell "never asked" from "already refused".
    // iOS shows its prompt once; after a refusal, asking again returns denied
    // silently and the only way back is the Settings app.
    const before = await getRecordingPermissionsAsync();
    const permission = before.granted ? before : await requestRecordingPermissionsAsync();
    if (!permission.granted) {
      if (!before.canAskAgain) {
        // Refused on an earlier occasion, so offer the way back. Deliberately
        // not after a refusal given just now: answering a fresh "no" with a
        // button to go and change it would be pressing the person to
        // reconsider, which App Store guideline 5.1.1(iv) rules out.
        Alert.alert(t('permissions.microphoneBlockedTitle'), t('permissions.microphoneBlockedBody'), [
          { text: t('conversation.cancel'), style: 'cancel' },
          { text: t('permissions.openSettings'), onPress: () => void Linking.openSettings() },
        ]);
      } else {
        setSendError(t('conversation.microphoneDenied'));
      }
      return;
    }
    try {
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const recorder = new AudioModule.AudioRecorder(iosRecorderOptions());
      recorderRef.current = recorder;
      // The part expo-audio cannot do: allowing the hands-free profile, which
      // is what makes the microphone on Bluetooth headphones usable at all.
      //
      // The order is the fix. expo-audio's recorder resets the audio session
      // with no options *when it is created* (AudioRecorder.swift), which
      // throws away the Bluetooth option -- so configuring first, as this
      // used to, was undone a moment later and the AirPods microphone was
      // never reachable. Configure after creating, before preparing: the
      // input is chosen when the recorder prepares.
      await configureForRecording();
      await recorder.prepareToRecordAsync();
      recorder.record();
      recordingStartedAt.current = Date.now();
      setRecordedSeconds(0);
      setRecording(true);
    } catch (error) {
      console.error('[ConversationScreen] failed to start recording', error);
      // Puts the session back, which also releases the screen: configuring for
      // recording pins it awake, and a start that failed half-way would
      // otherwise leave it that way until the app went to the background.
      await configureForPlayback();
      setSendError(t('conversation.recordingFailed'));
    }
  }, [t]);

  const stopRecording = useCallback(
    async (send: boolean) => {
      setRecording(false);
      setRecordedSeconds(0);
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (!recorder) return;

      try {
        await recorder.stop();
        const uri = recorder.uri;
        // Destroy the recorder and leave the recording audio mode, in that
        // order. While either survives, iOS keeps playback routed to the
        // earpiece and away from Bluetooth.
        recorder.release();
        await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
        await configureForPlayback();
        const durationMs = Math.min(Date.now() - recordingStartedAt.current, MAX_VOICE_DURATION_MS);
        if (!uri) return;
        if (!send || durationMs < 700) {
          // Too short to be anything but a mis-tap.
          await readRecordingAndDelete(uri);
          return;
        }
        const base64 = await readRecordingAndDelete(uri);
        await sendVoiceMessage(base64, durationMs);
      } catch (error) {
        console.error('[ConversationScreen] failed to finish recording', error);
        setSendError(t('conversation.recordingFailed'));
      }
    },
    [sendVoiceMessage, t],
  );

  // A recording has to end somewhere: the audio travels inside the message, so
  // there is a hard ceiling on how long it can be. Sending what was captured
  // rather than discarding it -- reaching the limit should not lose a minute
  // of someone's voice.
  useEffect(() => {
    if (!recording) return;
    const timer = setTimeout(() => void stopRecording(true), MAX_VOICE_DURATION_MS);
    const tick = setInterval(
      () => setRecordedSeconds(Math.floor((Date.now() - recordingStartedAt.current) / 1000)),
      500,
    );
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
  }, [recording, stopRecording]);

  // Ends a recording that iOS is about to break, and says so.
  //
  // Two ways it happens, and both are covered because they are reported
  // differently. A call arriving or Siri taking the microphone raises an audio
  // interruption, which the native module forwards. Pressing the side button,
  // or switching apps, does not: the app simply leaves the foreground, taking
  // the audio session with it. AppState sees that one.
  //
  // What is discarded here is deliberate. Audio recorded either side of a gap
  // is still a message with a gap in it, and the person speaking has no way of
  // knowing which words were lost -- so the recording ends, nothing is sent,
  // and they are told why. That is the whole point: silence about it was the
  // bug.
  useEffect(() => {
    if (!recording) return;

    const interrupted = () => {
      void stopRecording(false);
      setSendError(t('conversation.recordingInterrupted'));
    };

    const unsubscribe = onAudioInterruption(interrupted);
    const appState = AppState.addEventListener('change', (next) => {
      // 'background' only. iOS also reports 'inactive' for things that do not
      // touch the microphone at all -- pulling down Control Center, a banner
      // arriving -- and ending someone's recording because they glanced at a
      // notification would be a worse bug than the one this fixes.
      if (next === 'background') interrupted();
    });

    return () => {
      unsubscribe();
      appState.remove();
    };
  }, [recording, stopRecording, t]);

  const setGroupMembers = useConversationsStore((state) => state.setGroupMembers);
  const removeConversation = useConversationsStore((state) => state.removeConversation);
  const clearChannel = useMessagesStore((state) => state.clearChannel);
  const isOwner = isGroup && conversation?.ownerId === getCurrentUserId();

  // Refreshed from the server rather than trusted from local state: the owner
  // may have added or removed people while this device was elsewhere, and
  // sending to a stale list means either leaving someone out or encrypting to
  // someone who is no longer there.
  const refreshMembers = useCallback(async () => {
    if (!isGroup) return;
    try {
      setGroupMembers(channelId, await fetchChannelMembers(channelId));
    } catch (error) {
      console.error('[ConversationScreen] failed to refresh members', error);
    }
  }, [isGroup, channelId, setGroupMembers]);

  useEffect(() => {
    void refreshMembers();
  }, [refreshMembers]);

  const setConversationNickname = useConversationsStore((state) => state.setConversationNickname);

  /**
   * Names the group for everyone.
   *
   * Sent as an encrypted control message, silently, so it neither appears in
   * the conversation nor makes anyone's phone buzz. Applied locally first, so
   * the owner sees the result immediately rather than waiting on a round trip.
   */
  const handleRenameGroup = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      setConversationNickname(channelId, trimmed);
      setMembersNotice(null);
      try {
        await transmit(encodePayload({ text: '', groupName: trimmed }), { silent: true });
        setMembersNotice({ kind: 'ok', text: t('conversation.groupNameSent') });
      } catch (error) {
        console.error('[ConversationScreen] failed to announce group name', error);
        // Reported inside the sheet, not behind it. sendError draws on the
        // conversation itself, which the members modal covers -- so a rename
        // that failed looked exactly like one that silently did nothing, and
        // that is how this shipped.
        setMembersNotice({ kind: 'error', text: t('conversation.groupNameFailed') });
      }
    },
    [channelId, setConversationNickname, transmit, t],
  );

  const handleDeleteGroup = useCallback(() => {
    Alert.alert(t('conversation.deleteGroupTitle'), t('conversation.deleteGroupBody'), [
      { text: t('conversation.cancel'), style: 'cancel' },
      {
        text: t('conversation.deleteGroupConfirm'),
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteGroupChannel(channelId);
            clearChannel(channelId);
            removeConversation(channelId);
            setShowMembers(false);
            navigation.navigate('ConversationList');
          } catch (error) {
            setSendError(error instanceof Error ? error.message : String(error));
          }
        },
      },
    ]);
  }, [channelId, clearChannel, removeConversation, navigation, t]);

  const handleAddMember = useCallback(async () => {
    const peerId = newMemberId.trim();
    if (!peerId) return;
    try {
      await addGroupMember(channelId, peerId);
      setNewMemberId('');
      await refreshMembers();
      // Re-announce the name to the group. The original announcement went out
      // before this person was a member, so there was no copy encrypted for
      // them -- without this, everyone who joined later would see the group
      // unnamed while everyone else saw its name.
      const currentName = conversation?.nickname?.trim();
      if (currentName) await handleRenameGroup(currentName);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : String(error));
    }
  }, [channelId, newMemberId, refreshMembers]);

  /**
   * Blocks one member of a group, for this device only.
   *
   * Removing a member is the owner's power and takes them out for everyone.
   * This is the other thing entirely, available to anybody: their messages
   * stop reaching you -- here and in any private conversation -- while they
   * stay in the group and are never told. Every part of that already worked;
   * group messages from a blocked sender are dropped on arrival in
   * messaging/ingest.ts. What was missing was any way to ask for it, which in
   * a group is where it is most likely to be needed.
   *
   * Reported through membersNotice, inside the sheet. sendError draws on the
   * conversation behind it, where this modal would hide it -- the same trap
   * the group rename fell into.
   */
  const handleBlockMember = useCallback(
    (peerId: string) => {
      Alert.alert(t('conversation.blockMemberTitle'), t('conversation.blockMemberBody'), [
        { text: t('conversation.cancel'), style: 'cancel' },
        {
          text: t('conversation.blockMemberConfirm'),
          style: 'destructive',
          onPress: async () => {
            setMembersNotice(null);
            try {
              const { userId } = await registerIdentity();
              await blockPeer(userId, peerId);
              addBlockedPeer(peerId);
              setMembersNotice({ kind: 'ok', text: t('conversation.blockMemberDone') });
            } catch (error) {
              console.error('[ConversationScreen] failed to block member', error);
              setMembersNotice({ kind: 'error', text: t('conversation.blockMemberFailed') });
            }
          },
        },
      ]);
    },
    [addBlockedPeer, t],
  );

  const handleRemoveMember = useCallback(
    (peerId: string) => {
      Alert.alert(t('conversation.removeMemberTitle'), peerId, [
        { text: t('conversation.cancel'), style: 'cancel' },
        {
          text: t('conversation.removeMemberConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await removeGroupMember(channelId, peerId);
              await refreshMembers();
            } catch (error) {
              setSendError(error instanceof Error ? error.message : String(error));
            }
          },
        },
      ]);
    },
    [channelId, refreshMembers, t],
  );

  const handleReact = useCallback(
    async (messageId: string, emoji: string) => {
      const current = messages.find((m) => m.id === messageId)?.reactions?.mine;
      // Tapping the same emoji again takes the reaction back, which is what
      // every messenger does and what people expect without being told.
      const next = current === emoji ? '' : emoji;

      useMessagesStore.getState().applyReaction(channelId, messageId, 'mine', next);

      try {
        // silent: a reaction should not make the other phone buzz.
        await transmit(encodePayload({ text: next, reactsToMessageId: messageId }), {
          silent: true,
        });
      } catch (error) {
        console.error('[ConversationScreen] failed to send reaction', error);
        setSendError(t('conversation.reactionFailed'));
      }
    },
    [channelId, transmit, messages, t],
  );

  const handleDeleteMessage = useCallback(
    (messageId: string) => {
      Alert.alert(
        t('conversation.deleteTitle'),
        t('conversation.deleteMessageBody'),
        [
          { text: t('conversation.cancel'), style: 'cancel' },
          {
            text: t('conversation.deleteConfirm'),
            style: 'destructive',
            onPress: async () => {
              const target = messages.find((m) => m.id === messageId);
              // Drop it locally first: this user asked for it gone and
              // shouldn't watch it linger while the round trip happens.
              dropMessage(messageId);
              // A message that never reached the server has no row to delete,
              // and its local id is not even a uuid -- asking Postgres to
              // delete it would fail on the type, not on the lookup.
              if (messageId.startsWith('local-')) return;
              let failed = false;
              try {
                // Tell the other phones, encrypted, as a message of its
                // own: deleting the row below only reaches phones that are
                // connected right now, and one that was closed used to keep
                // its copy. This waits on the server for as long as the
                // message could still be on a phone -- its own remaining life
                // -- and no longer: after that there is nothing left to
                // delete. Silent, so nobody's phone buzzes for a deletion.
                const remaining = target ? Math.ceil((Date.parse(target.expiresAt) - Date.now()) / 1000) : 0;
                if (remaining > 0) {
                  const sent = await transmit(
                    encodePayload({
                      // Only for builds that predate this, which would
                      // otherwise show it as an empty message.
                      text: t('conversation.deletedFallback'),
                      deletesMessageId: messageId,
                    }),
                    { silent: true, lifetimeSeconds: Math.max(60, remaining) },
                  );
                  // Remembered so its echo from the server is recognised and
                  // not decrypted -- this phone cannot decrypt what it sent.
                  useMessagesStore.getState().addMessage(channelId, {
                    id: sent.id,
                    createdAt: sent.createdAt,
                    expiresAt: sent.expiresAt,
                    plaintext: '',
                    isMine: true,
                    isControl: true,
                    deletesId: messageId,
                  });
                }
              } catch (error) {
                console.error('[ConversationScreen] failed to announce a deletion', messageId, error);
                failed = true;
              }
              // Attempted either way: the server's copy should go even if the
              // phones could not be told.
              try {
                await deleteMessage(messageId);
              } catch (error) {
                console.error('[ConversationScreen] failed to delete message', messageId, error);
                failed = true;
              }
              if (failed) setLoadError(t('conversation.deleteFailed'));
            },
          },
        ],
      );
    },
    [channelId, dropMessage, messages, transmit, t],
  );

  // A screenshot taken while this conversation is on screen is announced to
  // everyone in it, as a line of its own. Deliberately a courtesy rather than
  // a protection, and the notice says no more than it can: iOS reports a
  // screenshot only after it has been taken, and a second phone's camera is
  // never detected at all. What it does give people is the knowledge that a
  // screenshot here is not silent -- which is most of the deterrent.
  //
  // iOS only: Android blocks screenshots outright (useScreenshotProtection),
  // and its listener would need a storage permission.
  //
  // Only while this screen is the one in front and the app is active, so a
  // screenshot of something else never lands in this conversation. At most
  // one notice per few seconds: a burst of screenshots is one fact.
  const lastScreenshotNoticeAt = useRef(0);
  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    const subscription = ScreenCapture.addScreenshotListener(() => {
      if (!navigation.isFocused() || AppState.currentState !== 'active') return;
      const now = Date.now();
      if (now - lastScreenshotNoticeAt.current < 5000) return;
      lastScreenshotNoticeAt.current = now;

      const localId = `local-${now}-${Math.random().toString(36).slice(2, 10)}`;
      addMessage(channelId, {
        id: localId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
        plaintext: '',
        isMine: true,
        notice: 'screenshot',
      });
      // Silent: it waits in the conversation rather than buzzing anyone.
      transmit(encodePayload({ text: t('conversation.screenshotFallback'), screenshot: true }), { silent: true })
        .then((sent) =>
          replaceMessage(channelId, localId, {
            id: sent.id,
            createdAt: sent.createdAt,
            expiresAt: new Date(Date.parse(sent.createdAt) + ttlSeconds * 1000).toISOString(),
            plaintext: '',
            isMine: true,
            notice: 'screenshot',
          }),
        )
        .catch((error) => {
          // Not sent, so not shown: a notice here claiming the others were
          // told, when they were not, would be the one dishonest outcome.
          console.error('[ConversationScreen] could not announce a screenshot', error);
          removeMessage(channelId, localId);
        });
    });
    return () => subscription.remove();
  }, [navigation, channelId, ttlSeconds, addMessage, replaceMessage, removeMessage, transmit, t]);

  // Long-press used to delete outright. Now that there are two things you can
  // do to a message it opens a menu instead -- deleting is destructive and
  // should not sit one tap away from replying.
  const handleMessageActions = useCallback(
    (messageId: string) => {
      // A message that never reached the server has no row to delete, and
      // nothing to reply to yet -- dropping it locally is the only sensible
      // action, and deleteMessage() below already tolerates that.
      const message = messages.find((m) => m.id === messageId);
      // Editing is offered only for your own messages that actually reached
      // the server. Editing one that never arrived is just typing it again,
      // and there is nothing on the other side to correct.
      // Not offered for voice: there is no way to edit a recording, and the
      // edit path would replace it with empty text.
      const canEdit =
        message?.isMine === true &&
        !messageId.startsWith('local-') &&
        !message.audioBase64 &&
        // Nor for images: there is no text to change, and an edit would
        // replace the picture with an empty message.
        !message.image;

      Alert.alert(t('conversation.messageActionsTitle'), undefined, [
        {
          text: t('conversation.react'),
          onPress: () =>
            Alert.alert(t('conversation.reactTitle'), undefined, [
              ...REACTION_EMOJIS.map((emoji) => ({
                text: emoji,
                onPress: () => void handleReact(messageId, emoji),
              })),
              { text: t('conversation.cancel'), style: 'cancel' as const },
            ]),
        },
        { text: t('conversation.reply'), onPress: () => setReplyToId(messageId) },
        // Not offered for a voice message, whose text is empty -- a menu item
        // that copies nothing is worse than no menu item.
        ...(message?.plaintext?.trim()
          ? [
              {
                text: t('conversation.copy'),
                onPress: () =>
                  void copyToClipboard(message.plaintext, t('conversation.messageCopied')),
              },
            ]
          : []),
        ...(canEdit
          ? [
              {
                text: t('conversation.edit'),
                onPress: () => {
                  setEditingId(messageId);
                  setReplyToId(null);
                  setInputText(message?.plaintext ?? '');
                  inputRef.current?.focus();
                },
              },
            ]
          : []),
        // Only for a message that reached the server; a local one has
        // nothing there to show.
        ...(message && !messageId.startsWith('local-')
          ? [
              {
                text: t('conversation.serverView'),
                onPress: () =>
                  navigation.navigate('MessageServerView', {
                    messageId,
                    isMine: message.isMine === true,
                    sentAt: message.createdAt,
                  }),
              },
            ]
          : []),
        ...(message && message.isMine !== true && !message.notice && !messageId.startsWith('local-')
          ? [
              {
                text: t('conversation.reportMessage'),
                onPress: () => handleReportMessage(message),
              },
            ]
          : []),
        {
          text: t('conversation.deleteConfirm'),
          style: 'destructive',
          onPress: () => handleDeleteMessage(messageId),
        },
        { text: t('conversation.cancel'), style: 'cancel' },
      ]);
    },
    [copyToClipboard, handleDeleteMessage, handleReact, handleReportMessage, messages, navigation, t],
  );

  // Lets an arriving notification know it has nothing to announce while this
  // conversation is being read. Cleared on the way out, so leaving the screen
  // restores normal notifications immediately.
  useEffect(() => {
    setActiveConversation(channelId);
    return () => setActiveConversation(null);
  }, [channelId]);

  // Everything visible here is read by definition. Re-running as `messages`
  // changes covers the message that arrives while the user is looking at the
  // conversation, which must not leave an unread badge behind.
  //
  // The newest message's time is passed so the store can tell a call that
  // changes something from one that does not. A catch-up burst calls this
  // once per message ingested, and every write from inside an effect counts
  // towards React's nested-update limit -- fifty of them in a chain is a
  // crash, which is what a notification opened onto a pile of messages used
  // to produce.
  // Compared as instants, not as strings. Timestamps reach this app in two
  // shapes -- the server's "+00:00" and this device's "Z" -- and "+" sorts
  // before "Z", so comparing the text would call an older message the newest
  // one and leave a conversation you are looking at marked unread.
  const newestMessageAt = messages.length
    ? messages.reduce(
        (latest, m) => (Date.parse(m.createdAt) > Date.parse(latest) ? m.createdAt : latest),
        messages[0].createdAt,
      )
    : undefined;
  useEffect(() => {
    markConversationRead(channelId, newestMessageAt);
  }, [channelId, newestMessageAt, markConversationRead]);

  // A safety-net fetch, not the main delivery path: useMessageSync (App.tsx)
  // already subscribes to every conversation and ingests as messages arrive.
  // This only covers the case where that subscription dropped without the app
  // restarting, so opening a conversation still catches up.
  useEffect(() => {
    let cancelled = false;

    fetchMessages(channelId)
      .then((fetched) => {
        if (cancelled) return;
        fetched.forEach((message) =>
          ingestFetchedMessage(channelId, peerUserId, message, getCurrentUserId() ?? undefined),
        );
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [channelId, peerUserId]);

  // The quoted message is resolved here, not carried inside the reply, so a
  // quote can never show text that has already expired. Returning undefined
  // is a real outcome, not an error: the original may have expired, been
  // deleted, or never have reached this device.
  const findQuoted = useCallback(
    (id: string | null | undefined) =>
      id ? orderedMessages.find((message) => message.id === id) : undefined,
    [orderedMessages],
  );

  const scrollToMessage = useCallback(
    (id: string) => {
      const index = orderedMessages.findIndex((message) => message.id === id);
      if (index < 0) return;
      listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.5 });
    },
    [orderedMessages],
  );

  /**
   * Puts the message on screen first, then sends it.
   *
   * It used to be the other way round -- the message only appeared once the
   * server had accepted it -- which meant a failed send produced no message at
   * all, just a line of red text, and the only copy of what you wrote was
   * whatever was left in the input box. Showing it immediately with a state
   * attached is both more honest and more useful: a failed message is still
   * there, still readable, and can be retried.
   */
  const deliver = useCallback(
    async (localId: string, text: string, replyTo: string | undefined, messageTtl: number) => {
      try {
        const { id, createdAt, expiresAt } = await transmit(
          // The lifetime rides inside the encryption whenever it differs from
          // the conversation's, so the recipient's copy expires with the
          // sender's rather than outliving it.
          encodePayload({
            text,
            replyToId: replyTo,
            localTtlSeconds: messageTtl === ttlSeconds ? undefined : messageTtl,
          }),
          { serverTtlSeconds: messageTtl },
        );
        replaceMessage(channelId, localId, {
          id,
          createdAt,
          expiresAt,
          plaintext: text,
          isMine: true,
          replyToId: replyTo,
          status: 'sent',
        });
        scheduleExpiry(id, expiresAt);
      } catch (error) {
        setMessageStatus(channelId, localId, 'failed');
        if (error instanceof EmptyGroupError) {
          setSendError(t('conversation.emptyGroupNotice'));
        } else if (isUntrustedIdentityError(error)) {
          setSendSecurityWarning(t('conversation.securityWarningSend', { peerId: peerUserId }));
        }
        console.error('[ConversationScreen] failed to send message', error);
      }
    },
    [channelId, transmit, ttlSeconds, replaceMessage, setMessageStatus, scheduleExpiry, t],
  );

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;

    setSending(true);
    setSendError(null);

    if (editingId) {
      const editedAt = new Date().toISOString();
      // Applied locally first: the sender should see their correction
      // immediately, exactly like a normal send.
      applyEdit(channelId, editingId, text, editedAt);
      setInputText('');
      setEditingId(null);
      setSending(false);
      inputRef.current?.focus();

      try {
        await transmit(encodePayload({ text, editsMessageId: editingId }));
      } catch (error) {
        console.error('[ConversationScreen] failed to send edit', error);
        setSendError(t('conversation.editFailed'));
      }
      return;
    }

    // Local only, and never sent anywhere: the server assigns the real id.
    // Prefixed so it can never be mistaken for one.
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const replyTo = replyToId ?? undefined;
    const messageTtl = oneOffTtlSeconds ?? ttlSeconds;

    addMessage(channelId, {
      id: localId,
      createdAt: new Date().toISOString(),
      // A guess until the server rules. It only affects the countdown shown
      // for the second or two before the real value arrives.
      expiresAt: new Date(Date.now() + messageTtl * 1000).toISOString(),
      plaintext: text,
      isMine: true,
      replyToId: replyTo,
      status: 'sending',
    });
    setInputText('');
    setOneOffTtlSeconds(null);
    setReplyToId(null);
    setSending(false);
    // Belt and braces alongside keeping the field editable: whatever else
    // steals the focus, the keyboard should be where the user left it.
    inputRef.current?.focus();

    await deliver(localId, text, replyTo, messageTtl);
  };

  // Always confirms, and always shows the full address. A link in a message
  // came from someone else, and the text of a link never has to match where it
  // goes -- seeing the real destination before leaving the app is the only
  // defence the reader has. Opening it hands the site this device's IP, which
  // is a choice worth making deliberately rather than by a stray tap.
  const handleOpenLink = useCallback(
    (url: string) => {
      Alert.alert(t('conversation.openLinkTitle'), url, [
        { text: t('conversation.cancel'), style: 'cancel' },
        {
          // Copying is the safer half of this dialog: it takes the address
          // without handing the site this device's IP.
          text: t('conversation.copyLink'),
          onPress: () => void copyToClipboard(url, t('conversation.linkCopied')),
        },
        {
          text: t('conversation.openLinkConfirm'),
          onPress: () => {
            Linking.openURL(url).catch((error) => {
              console.error('[ConversationScreen] failed to open link', error);
              setSendError(t('conversation.openLinkFailed'));
            });
          },
        },
      ]);
    },
    [copyToClipboard, t],
  );

  const handleRetry = useCallback(
    (message: DecryptedMessage) => {
      // A voice message goes again as a voice message. Retrying used to
      // resend `plaintext`, which is empty for a recording -- so it went out,
      // to both phones, as a blank bubble, and the recording was never sent.
      if (message.audioBase64) {
        void sendVoiceMessage(message.audioBase64, message.audioDurationMs ?? 0, message.id);
        return;
      }
      // Nothing to resend. Never reached today (images have no retry, and
      // every other failed message has text), but an empty message must not
      // be the thing that goes out if that ever changes.
      if (!message.plaintext.trim()) return;
      setMessageStatus(channelId, message.id, 'sending');
      void deliver(message.id, message.plaintext, message.replyToId, ttlSeconds);
    },
    [channelId, deliver, sendVoiceMessage, ttlSeconds, setMessageStatus],
  );

  return (
    // A plain view with a spacer at the bottom, rather than
    // KeyboardAvoidingView -- see hooks/useKeyboardSpacer for what that one
    // does wrong. It also drops the header-height offset this used to need:
    // the spacer lives inside the layout, so the bar sits exactly the
    // keyboard's height above the bottom of the screen with nothing to
    // correct for.
    <View style={styles.flex}>
      {/* Bottom edge only. The navigation header already occupies the space
          the top inset is for, and padding it a second time left a band of
          empty screen above the disappearing-message row -- which is why that
          setting sat far lower than it should. */}
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={['bottom']}>
        {loadError ? (
          <Text style={[styles.errorText, { color: colors.danger }]}>{loadError}</Text>
        ) : null}

        {isGroup && (groupMemberIds?.length ?? 0) <= 1 ? (
          <View style={[styles.securityWarning, { backgroundColor: colors.surfaceAlt, borderColor: colors.accent }]}>
            <Text style={[styles.securityWarningText, { color: colors.textSecondary }]}>
              {t('conversation.emptyGroupNotice')}
            </Text>
          </View>
        ) : null}

        {securityWarning ? (
          <View style={[styles.securityWarning, { backgroundColor: colors.surfaceAlt, borderColor: colors.danger }]}>
            <Text style={[styles.securityWarningText, { color: colors.danger }]}>{securityWarning}</Text>
          </View>
        ) : null}

        {/* A band of its own, a shade off the page, so the disappearing timer
            reads as a setting that governs the conversation rather than as
            the first thing in it. */}
        <View style={[styles.ttlBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
        <Text style={[styles.ttlLabel, { color: colors.textSecondary }]}>
          {t('conversation.ttlLabel')}
        </Text>

        <View style={styles.ttlRow}>
          {TTL_OPTIONS.map((option) => {
            const selected = option.seconds === ttlSeconds;
            return (
              <Pressable
                key={option.seconds}
                onPress={() => setConversationTtl(channelId, option.seconds)}
                style={[
                  styles.ttlChip,
                  {
                    // Surface, not surfaceAlt: that is the band's own colour
                    // now, and a chip painted in it would vanish into it.
                    backgroundColor: selected ? colors.accent : colors.surface,
                    borderColor: colors.border,
                  },
                ]}
              >
                <Text style={{ color: selected ? colors.onAccent : colors.textSecondary, fontSize: 12 }}>
                  {t(`conversation.ttl.${option.key}`)}
                </Text>
              </Pressable>
            );
          })}
        </View>
        </View>

        {/* Inverted, which is how chat lists solve "always show the newest".
            The list is rendered bottom-up, so it opens at the most recent
            message and stays pinned there as messages arrive -- with no
            scrollToEnd() calls, and, importantly, without yanking the view
            away from someone who has scrolled up to read older messages.

            The empty state is a sibling branch rather than
            ListEmptyComponent for two reasons: an inverted list flips its
            children, so a placeholder inside it renders upside down; and
            rendering exactly one of the two means the list can safely take
            `flex: 1` without competing with the placeholder for height. */}
        {orderedMessages.length === 0 ? (
          <View style={styles.messages}>
            <Text style={[styles.placeholder, { color: colors.textSecondary }]}>
              {t('conversation.emptyState')}
            </Text>
          </View>
        ) : (
        <FlatList
          ref={listRef}
          data={orderedMessages}
          inverted
          style={styles.flex}
          // Jumping to a quoted message can target one that has not been
          // rendered yet, which throws unless handled. Silently ignoring is
          // right here: failing to scroll is a much smaller problem than
          // crashing, and the message is still reachable by hand.
          onScrollToIndexFailed={() => {}}
          // Without this, the first tap anywhere in the list is swallowed to
          // dismiss the keyboard -- so long-pressing a message to reply while
          // typing would need two attempts.
          keyboardShouldPersistTaps="handled"
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.messagesContent}
          renderItem={({ item }) =>
            item.notice === 'screenshot' ? (
              <View style={styles.noticeRow}>
                <Text style={[styles.noticeText, { color: colors.textSecondary }]}>
                  {item.isMine === true
                    ? t('conversation.screenshotNoticeMine')
                    : t('conversation.screenshotNoticeTheirs', {
                        name:
                          (isGroup
                            ? item.senderUserId && peerNickname(allConversations, item.senderUserId)
                            : conversationName) || t('conversation.screenshotSomeone'),
                      })}
                  {' · '}
                  {formatSentAt(item.createdAt)}
                </Text>
              </View>
            ) : (
            <Pressable
              onLongPress={() => handleMessageActions(item.id)}
              delayLongPress={350}
              style={[
                styles.messageBubble,
                item.isMine === true
                  ? [styles.messageBubbleMine, { backgroundColor: colors.accent }]
                  : { backgroundColor: colors.surfaceAlt },
              ]}
            >
              {item.replyToId ? (
                <Pressable
                  onPress={() => scrollToMessage(item.replyToId as string)}
                  style={[
                    styles.quoteBlock,
                    {
                      borderLeftColor: item.isMine === true ? colors.onAccent : colors.accent,
                      backgroundColor: item.isMine === true ? colors.accentPressed : colors.surface,
                    },
                  ]}
                >
                  <Text
                    numberOfLines={2}
                    style={[
                      styles.quoteText,
                      {
                        color: item.isMine === true ? colors.onAccent : colors.textSecondary,
                      },
                      !findQuoted(item.replyToId) && styles.quoteMissing,
                    ]}
                  >
                    {quotePreview(findQuoted(item.replyToId), t)}
                  </Text>
                </Pressable>
              ) : null}

              {item.image ? (
                <ImageMessage
                  channelId={channelId}
                  messageId={item.id}
                  image={item.image}
                  concealed={item.isMine !== true}
                  tint={item.isMine === true ? colors.onAccent : colors.textPrimary}
                  onLongPress={() => handleMessageActions(item.id)}
                />
              ) : item.audioBase64 ? (
                <VoiceMessage
                  messageId={item.id}
                  audioBase64={item.audioBase64}
                  durationMs={item.audioDurationMs}
                  tint={item.isMine === true ? colors.onAccent : colors.textPrimary}
                  onLongPress={() => handleMessageActions(item.id)}
                />
              ) : item.isMine !== true && !revealedIds.has(item.id) && isObjectionable(item.plaintext) ? (
              <Pressable
                onPress={() => setRevealedIds((current) => new Set(current).add(item.id))}
                onLongPress={() => handleMessageActions(item.id)}
                delayLongPress={350}
                accessibilityRole="button"
              >
                <Text style={[styles.hiddenMessage, { color: colors.textSecondary }]}>
                  {t('conversation.hiddenMessage')}
                </Text>
              </Pressable>
              ) : (
              <Text style={{ color: item.isMine === true ? colors.onAccent : colors.textPrimary }}>
                {splitLinks(item.plaintext).map((segment, index) =>
                  segment.url ? (
                    <Text
                      key={index}
                      style={styles.link}
                      onPress={() => handleOpenLink(segment.url as string)}
                    >
                      {segment.text}
                    </Text>
                  ) : (
                    segment.text
                  ),
                )}
              </Text>
              )}
              <Text
                style={[
                  styles.messageExpiry,
                  { color: item.isMine === true ? colors.onAccent : colors.textSecondary },
                  item.isMine === true && styles.messageExpiryMine,
                ]}
              >
                {formatSentAt(item.createdAt)} · {formatTimeLeft(item.expiresAt, now, t)}
                {item.editedAt ? ` · ${t('conversation.edited')}` : ''}
                {item.status ? ` · ${t(`conversation.status.${item.status}`)}` : ''}
              </Text>

              {item.reactions && (item.reactions.mine || item.reactions.theirs) ? (
                <View style={[styles.reactionRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                  <Text style={styles.reactionText}>
                    {[item.reactions.theirs, item.reactions.mine].filter(Boolean).join(' ')}
                  </Text>
                </View>
              ) : null}

              {/* Not for an image: retrying resends the message's text, and an
                  image's text is empty -- it would go out as a blank message.
                  A failed picture says so on itself; sending it again is
                  choosing it again. */}
              {item.status === 'failed' && !item.image ? (
                <Pressable onPress={() => handleRetry(item)} hitSlop={8}>
                  <Text style={[styles.retryText, { color: colors.onAccent }]}>
                    {t('conversation.retrySend')}
                  </Text>
                </Pressable>
              ) : null}
            </Pressable>
            )
          }
        />
        )}

        {sendError ? (
          <Text style={[styles.sendErrorText, { color: colors.danger }]}>{sendError}</Text>
        ) : null}

        {notice ? (
          <Text style={[styles.sendErrorText, { color: colors.textSecondary }]}>{notice}</Text>
        ) : null}

        {editingId ? (
          <View style={[styles.replyBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <View style={[styles.replyBarAccent, { backgroundColor: colors.accent }]} />
            <View style={styles.replyBarTextWrapper}>
              <Text style={[styles.replyBarLabel, { color: colors.accent }]}>
                {t('conversation.editingMessage')}
              </Text>
              <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 13 }}>
                {t('conversation.editingHint')}
              </Text>
            </View>
            <Pressable
              onPress={() => {
                setEditingId(null);
                setInputText('');
              }}
              hitSlop={12}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        ) : null}

        {oneOffTtlSeconds !== null ? (
          <View style={[styles.replyBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <View style={[styles.replyBarAccent, { backgroundColor: colors.danger }]} />
            <View style={styles.replyBarTextWrapper}>
              <Text style={[styles.replyBarLabel, { color: colors.danger }]}>
                {t('conversation.oneOffTtlActive', {
                  label: t(
                    `conversation.ttl.${TTL_OPTIONS.find((o) => o.seconds === oneOffTtlSeconds)?.key ?? '30s'}`,
                  ),
                })}
              </Text>
              <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 13 }}>
                {t('conversation.oneOffTtlHint')}
              </Text>
            </View>
            <Pressable onPress={() => setOneOffTtlSeconds(null)} hitSlop={12}>
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        ) : null}

        {sharedImage ? (
          <View style={[styles.replyBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <Image
              source={{ uri: sharedImage.uri }}
              style={styles.sharedImageThumb}
              resizeMode="cover"
              accessibilityLabel={t('conversation.imageLabel')}
            />
            <View style={styles.replyBarTextWrapper}>
              <Text style={[styles.replyBarLabel, { color: colors.accent }]}>{t('conversation.sharedImageTitle')}</Text>
              <Text numberOfLines={2} style={{ color: colors.textSecondary, fontSize: 13 }}>
                {t('conversation.sharedImageHint')}
              </Text>
            </View>
            <Pressable
              onPress={sendSharedImage}
              style={({ pressed }) => [
                styles.sharedImageSend,
                { backgroundColor: pressed ? colors.accentPressed : colors.accent },
              ]}
              accessibilityRole="button"
            >
              <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{t('conversation.sharedImageSend')}</Text>
            </Pressable>
            <Pressable
              onPress={() => replaceSharedImage(null)}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={t('conversation.sharedImageDiscard')}
            >
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        ) : null}

        {replyToId ? (
          <View style={[styles.replyBar, { backgroundColor: colors.surfaceAlt, borderColor: colors.border }]}>
            <View style={[styles.replyBarAccent, { backgroundColor: colors.accent }]} />
            <View style={styles.replyBarTextWrapper}>
              <Text style={[styles.replyBarLabel, { color: colors.accent }]}>
                {t('conversation.replyingTo')}
              </Text>
              <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 13 }}>
                {quotePreview(findQuoted(replyToId), t)}
              </Text>
            </View>
            <Pressable onPress={() => setReplyToId(null)} hitSlop={12}>
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </Pressable>
          </View>
        ) : null}

        <View style={[styles.inputBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {/* Hidden while recording, when it could only interrupt, and while
              editing, when a picture cannot replace the text being edited. */}
          {!recording && !editingId ? (
            <Pressable
              onPress={chooseImageSource}
              hitSlop={8}
              style={styles.attachButton}
              accessibilityRole="button"
              accessibilityLabel={t('conversation.attachImage')}
            >
              <ImageIcon size={22} color={colors.textSecondary} />
            </Pressable>
          ) : null}
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: colors.textPrimary }]}
            placeholder={t('conversation.inputPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            value={inputText}
            onChangeText={setInputText}
            // Deliberately always editable. It used to be disabled while a
            // message was in flight, and iOS takes the focus away from a field
            // that stops being editable -- taking the keyboard down with it,
            // and not bringing either back afterwards. That made sending
            // several messages in a row mean reopening the keyboard every
            // time. There is nothing to protect against now anyway: the
            // message is added to the conversation immediately, so typing the
            // next one while the last is still sending is perfectly fine.
            multiline
            blurOnSubmit={false}
          />
          {recording ? (
            <Pressable onPress={() => void stopRecording(false)} hitSlop={8} style={styles.discardButton}>
              <Text style={{ color: colors.textSecondary, fontSize: 18 }}>×</Text>
            </Pressable>
          ) : null}

          {!inputText.trim() ? (
            <Pressable
              onPress={() => (recording ? void stopRecording(true) : void startRecording())}
              style={({ pressed }) => [
                styles.sendButton,
                { backgroundColor: recording ? colors.danger : pressed ? colors.accentPressed : colors.accent },
              ]}
            >
              <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
                {recording
                  ? t('conversation.stopRecording', {
                      elapsed: `${Math.floor(recordedSeconds / 60)}:${String(recordedSeconds % 60).padStart(2, '0')}`,
                    })
                  : t('conversation.recordButton')}
              </Text>
            </Pressable>
          ) : null}

          <Pressable
            disabled={sending || !inputText.trim()}
            onPress={handleSend}
            // Long-press to give this one message a shorter life than the
            // conversation's. Tucked away on purpose: it is for the
            // occasional address or password, and a permanent row of extra
            // buttons above the keyboard would cost every message to serve a
            // few.
            onLongPress={() => {
              const shorter = TTL_OPTIONS.filter((option) => option.seconds < ttlSeconds);
              // Nothing to offer when the conversation is already at the
              // shortest timer: an alert with only a cancel button reads like
              // a bug.
              if (shorter.length === 0) return;
              Alert.alert(t('conversation.oneOffTtlTitle'), t('conversation.oneOffTtlHint'), [
                ...shorter.map((option) => ({
                  text: t(`conversation.ttl.${option.key}`),
                  onPress: () => setOneOffTtlSeconds(option.seconds),
                })),
                { text: t('conversation.cancel'), style: 'cancel' as const },
              ]);
            }}
            delayLongPress={350}
            style={({ pressed }) => [
              styles.sendButton,
              { backgroundColor: pressed ? colors.accentPressed : colors.accent },
              (sending || !inputText.trim()) && styles.sendButtonDisabled,
              !inputText.trim() && styles.hidden,
            ]}
          >
            <Text style={{ color: colors.onAccent, fontWeight: '600' }}>{t('conversation.sendButton')}</Text>
          </Pressable>
        </View>
        <Modal
          visible={showSafetyNumber}
          transparent
          animationType="fade"
          onRequestClose={() => setShowSafetyNumber(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setShowSafetyNumber(false)}>
            <Pressable style={styles.safetyWrapper} onPress={(event) => event.stopPropagation()}>
              <SafetyNumberCard
                peerUserId={peerUserId}
                // Offered only when the conversation is actually blocked by a
                // changed key. A permanent "trust anything" button would be a
                // reflex rather than a decision.
                showResetOption={untrusted}
                onReset={() => {
                  clearUntrusted(channelId);
                  setShowSafetyNumber(false);
                }}
              />
              <Pressable onPress={() => setShowSafetyNumber(false)} style={styles.membersClose}>
                <Text style={{ color: colors.accent, fontWeight: '600' }}>
                  {t('conversation.close')}
                </Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        <Modal
          visible={showMembers}
          transparent
          animationType="fade"
          onRequestClose={() => setShowMembers(false)}
        >
          <Pressable style={styles.modalBackdrop} onPress={() => setShowMembers(false)}>
            <Pressable
              style={[styles.membersCard, { backgroundColor: colors.surface, borderColor: colors.border }]}
              onPress={(event) => event.stopPropagation()}
            >
              <Text style={[styles.membersTitle, { color: colors.textPrimary }]}>
                {t('conversation.membersTitle')}
              </Text>

              {(groupMemberIds ?? []).map((memberId) => {
                const isSelf = memberId === getCurrentUserId();
                const blocked = blockedPeerIds.includes(memberId);
                // The name you gave this person in your own conversation with
                // them, if you have one. Never leaves the phone, and is not
                // what anyone else in the group sees.
                const name = isSelf
                  ? t('conversation.memberYou')
                  : peerNickname(allConversations, memberId);
                return (
                  <View key={memberId} style={styles.memberRow}>
                    <View style={styles.memberIdentity}>
                      <Text style={{ color: colors.textPrimary, fontSize: 14 }} numberOfLines={1}>
                        {name ?? `${memberId.slice(0, 8)}…`}
                      </Text>
                      {name ? (
                        <Text style={{ color: colors.textSecondary, fontSize: 11 }} numberOfLines={1}>
                          {memberId}
                        </Text>
                      ) : null}
                    </View>
                    {isSelf ? null : blocked ? (
                      <Text style={{ color: colors.textSecondary, fontSize: 13 }}>
                        {t('conversation.blockMemberBlocked')}
                      </Text>
                    ) : (
                      <Pressable onPress={() => handleBlockMember(memberId)} hitSlop={8}>
                        <Text style={{ color: colors.danger, fontSize: 13 }}>
                          {t('conversation.blockMemberButton')}
                        </Text>
                      </Pressable>
                    )}
                    {isOwner && !isSelf ? (
                      <Pressable onPress={() => handleRemoveMember(memberId)} hitSlop={8}>
                        <Text style={{ color: colors.danger, fontSize: 13 }}>
                          {t('conversation.removeMemberConfirm')}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}

              {membersNotice ? (
                <Text
                  style={{
                    color: membersNotice.kind === 'error' ? colors.danger : colors.textSecondary,
                    fontSize: 13,
                    marginTop: 4,
                  }}
                >
                  {membersNotice.text}
                </Text>
              ) : null}

              {isOwner ? (
                <View style={styles.addMemberRow}>
                  <TextInput
                    style={[styles.addMemberInput, { color: colors.textPrimary, borderColor: colors.border }]}
                    placeholder={t('conversation.groupNamePlaceholder')}
                    placeholderTextColor={colors.textSecondary}
                    value={groupNameDraft}
                    onChangeText={setGroupNameDraft}
                  />
                  <Pressable
                    onPress={() => void handleRenameGroup(groupNameDraft)}
                    style={[styles.sendButton, { backgroundColor: colors.accent }]}
                  >
                    <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
                      {t('conversation.groupNameSave')}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {isOwner ? (
                <View style={styles.addMemberRow}>
                  <TextInput
                    style={[styles.addMemberInput, { color: colors.textPrimary, borderColor: colors.border }]}
                    placeholder={t('conversation.addMemberPlaceholder')}
                    placeholderTextColor={colors.textSecondary}
                    value={newMemberId}
                    onChangeText={setNewMemberId}
                    autoCapitalize="none"
                    autoCorrect={false}
                  />
                  <Pressable
                    onPress={handleAddMember}
                    style={[styles.sendButton, { backgroundColor: colors.accent }]}
                  >
                    <Text style={{ color: colors.onAccent, fontWeight: '600' }}>
                      {t('conversation.addMemberButton')}
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <Text style={[styles.membersNote, { color: colors.textSecondary }]}>
                  {t('conversation.groupOwnerNote')}
                </Text>
              )}

              <Text style={[styles.membersNote, { color: colors.textSecondary }]}>
                {t('conversation.groupNoHistoryNote')}
              </Text>

              {isOwner ? (
                <Pressable onPress={handleDeleteGroup} style={styles.deleteGroupButton}>
                  <Text style={{ color: colors.danger, fontWeight: '600' }}>
                    {t('conversation.deleteGroupButton')}
                  </Text>
                </Pressable>
              ) : null}

              <Pressable onPress={() => setShowMembers(false)} style={styles.membersClose}>
                <Text style={{ color: colors.accent, fontWeight: '600' }}>
                  {t('conversation.close')}
                </Text>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
        <Animated.View style={{ height: keyboardSpacer }} />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  headerButtons: {
    flexDirection: 'row',
    gap: 14,
    paddingRight: 4,
  },
  container: {
    flex: 1,
  },
  ttlBar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  ttlLabel: {
    fontSize: 12,
    paddingHorizontal: 16,
    paddingTop: 10,
  },
  messageExpiry: {
    fontSize: 10,
    marginTop: 4,
  },
  ttlRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 16,
    paddingTop: 6,
    // The chips had no space beneath them at all, so they sat directly on
    // whatever came next. This separates the setting from the conversation.
    paddingBottom: 14,
  },
  ttlChip: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  messagesContent: {
    flexGrow: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
  },
  messages: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  placeholder: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  errorText: {
    fontSize: 13,
    textAlign: 'center',
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  securityWarning: {
    marginHorizontal: 16,
    marginTop: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  securityWarningText: {
    fontSize: 13,
    lineHeight: 18,
  },
  discardButton: {
    paddingHorizontal: 6,
  },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  safetyWrapper: {
    width: '100%',
    gap: 8,
  },
  membersCard: {
    width: '100%',
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 10,
  },
  membersTitle: {
    fontSize: 16,
    fontWeight: '600',
    marginBottom: 4,
  },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  memberIdentity: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  addMemberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
  },
  addMemberInput: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 14,
  },
  membersNote: {
    fontSize: 12,
    lineHeight: 17,
    marginTop: 6,
  },
  deleteGroupButton: {
    alignSelf: 'flex-start',
    marginTop: 10,
  },
  membersClose: {
    alignSelf: 'flex-end',
    marginTop: 8,
  },
  hidden: {
    display: 'none',
  },
  reactionRow: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 3,
    marginTop: 6,
  },
  reactionText: {
    fontSize: 14,
  },
  link: {
    textDecorationLine: 'underline',
    fontWeight: '600',
  },
  retryText: {
    fontSize: 12,
    fontWeight: '700',
    textDecorationLine: 'underline',
    marginTop: 4,
  },
  quoteBlock: {
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
  },
  quoteText: {
    fontSize: 13,
  },
  quoteMissing: {
    fontStyle: 'italic',
    opacity: 0.8,
  },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyBarAccent: {
    width: 3,
    alignSelf: 'stretch',
    borderRadius: 2,
  },
  replyBarTextWrapper: {
    flex: 1,
  },
  hiddenMessage: {
    fontStyle: 'italic',
    fontSize: 14,
  },
  noticeRow: {
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginVertical: 4,
  },
  noticeText: {
    fontSize: 12,
    textAlign: 'center',
  },
  replyBarLabel: {
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 2,
  },
  sharedImageThumb: {
    width: 44,
    height: 44,
    borderRadius: 6,
  },
  sharedImageSend: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  messageBubble: {
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
    alignSelf: 'flex-start',
    maxWidth: '80%',
  },
  // Own messages sit on the right in the accent colour, the convention every
  // messenger uses. Before this, every bubble was identical and left-aligned,
  // so a real back-and-forth was unreadable -- you could not tell who said
  // what.
  messageBubbleMine: {
    alignSelf: 'flex-end',
  },
  messageExpiryMine: {
    opacity: 0.8,
    textAlign: 'right',
  },
  sendErrorText: {
    fontSize: 13,
    paddingHorizontal: 16,
    paddingBottom: 4,
  },
  attachButton: {
    alignSelf: 'flex-end',
    paddingHorizontal: 4,
    paddingBottom: 9,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    margin: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  input: {
    flex: 1,
    fontSize: 15,
    maxHeight: 120,
    paddingVertical: 6,
  },
  sendButton: {
    borderRadius: 10,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  sendButtonDisabled: {
    opacity: 0.6,
  },
});
