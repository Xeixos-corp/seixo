import { create } from 'zustand';
import { Vibration } from 'react-native';
import {
  mediaDevices,
  RTCPeerConnection,
  RTCSessionDescription,
  type MediaStream,
} from 'react-native-webrtc';
import i18n from '../i18n';
import { encryptForPeer } from '../messaging/encryptForPeer';
import { encodePayload, type CallSignal } from '../messaging/payload';
import { sendMessage } from '../transport/messages';
import { supabase } from '../transport/supabaseClient';
import { useMessagesStore, type StoredCall } from '../store/messagesStore';
import { useConversationsStore, DEFAULT_TTL_SECONDS, conversationDisplayName } from '../store/conversationsStore';
import { startCallAudio, stopCallAudio, setCallSpeaker, onCallRouteChange } from '../../modules/audio-session-expo/src';
import {
  hasCallKit,
  reportIncomingCall,
  startOutgoingCall,
  reportOutgoingConnected,
  endCall as endCallKitCall,
  setCallMuted,
  onCallKitEvent,
} from '../../modules/calls-expo/src';
import { RTCAudioSession } from 'react-native-webrtc';
import { requestCallPush } from './callPush';
import { startRingback, stopRingback, playBusy, BUSY_TONE_MS } from './callTones';

/**
 * Voice calls, one to one.
 *
 * The sound goes over WebRTC, which encrypts it end to end on its own
 * (DTLS-SRTP). What WebRTC does not provide is a way for two phones to find
 * each other and agree on a call: that "signalling" is done here with ordinary
 * Seixo messages, encrypted with the Signal session the conversation already
 * has (messaging/payload.ts, `call`). The server therefore sees rows in a
 * conversation and nothing else: not that a call happened, not who placed it,
 * not how long it lasted. It also means the keys that protect the sound are
 * agreed inside the Signal session, so the server could not step into the
 * middle of a call even if it wanted to (the fingerprints in the SDP are what
 * DTLS checks, and they arrive encrypted).
 *
 * Signalling is not "trickled": each side gathers its network candidates
 * first and sends one complete description. Every signal is a database row
 * and a realtime event, so a handful of messages per call beats dozens.
 *
 * Phase 1 of the plan (memory: seixo-voice-calls-plan): calls while the app is
 * open, direct connection only. The relay server that hides each side's
 * address from the other comes before release; until then the phones connect
 * directly and each can learn the other's IP address.
 */

export type CallPhase = 'idle' | 'outgoing' | 'incoming' | 'connecting' | 'active';

type CallState = {
  phase: CallPhase;
  callId: string | null;
  channelId: string | null;
  peerUserId: string | null;
  /** True when this phone placed the call. */
  outgoing: boolean;
  /** When the two sides were first connected; drives the timer on screen. */
  connectedAt: number | null;
  muted: boolean;
  speaker: boolean;
  /** Set briefly after a call ends, so the screen can say why before closing. */
  endedReason: StoredCall['outcome'] | 'ended' | null;
};

export const useCallStore = create<CallState>(() => ({
  phase: 'idle',
  callId: null,
  channelId: null,
  peerUserId: null,
  outgoing: false,
  connectedAt: null,
  muted: false,
  speaker: false,
  endedReason: null,
}));

/**
 * The relay this call goes through: short-lived Cloudflare TURN credentials
 * from the call-turn Edge Function, made for this call.
 *
 * Relay only, always (`iceTransportPolicy: 'relay'` below), even between
 * contacts. A direct connection would hand each phone the other's IP address,
 * which for a messenger without phone numbers is often the most identifying
 * thing about a person. Signal relays only calls with strangers; here every
 * call is relayed, and the privacy policy says so. If no credentials can be
 * had, the call fails rather than falling back to a direct path.
 */
async function relayServers(): Promise<{ urls: string[]; username?: string; credential?: string }[]> {
  const { data, error } = await supabase.functions.invoke('call-turn', { body: {} });
  if (error) throw error;
  const servers = (data as { iceServers?: { urls: string[]; username?: string; credential?: string }[] })?.iceServers;
  if (!servers?.length) throw new Error('no relay servers');
  return servers;
}

/** How long a call rings before giving up, on both sides. */
const RING_SECONDS = 45;
/**
 * An offer older than this is not rung: it is a call that already gave up,
 * found by a catch-up fetch. It becomes a missed call instead.
 */
const STALE_OFFER_SECONDS = RING_SECONDS - 5;
/** How long gathering network candidates may take before sending what there is. */
const ICE_GATHER_TIMEOUT_MS = 3000;
/** How long a dropped connection may try to come back before the call is ended. */
const RECONNECT_GRACE_MS = 10_000;
/** Call rows are of no use to anyone after a day; the server need not keep them longer. */
const SIGNAL_SERVER_TTL_SECONDS = 24 * 60 * 60;

let peerConnection: RTCPeerConnection | null = null;
let localStream: MediaStream | null = null;
/** The offer received for an incoming call, kept until it is answered or dismissed. */
let pendingOfferSdp: string | null = null;
/** When the incoming offer was created, for the call log. */
let callStartedAt: string | null = null;
let ringTimer: ReturnType<typeof setTimeout> | null = null;
let dropTimer: ReturnType<typeof setTimeout> | null = null;
let clearEndedTimer: ReturnType<typeof setTimeout> | null = null;
// The app's speaker button follows the route wherever it was changed.
onCallRouteChange((speaker) => {
  if (useCallStore.getState().phase !== 'idle') useCallStore.setState({ speaker });
});

/** Call ids already finished on this phone, so a late signal cannot revive one. */
const finishedCalls = new Set<string>();
/** Calls a VoIP push made ring, before their offer has been decrypted here. */
const pushedCalls = new Set<string>();
/**
 * A call answered on the lock screen before its offer was read: the push
 * woke the app, and the person was quicker than the sync. Answered as soon as
 * the offer arrives.
 */
let answerOnArrival: string | null = null;
/**
 * Changes to the connection, applied one after another. The demo account's
 * renegotiation can arrive a moment after its answer, before the answer has
 * been applied; running them in order keeps WebRTC's state machine happy.
 */
let negotiation: Promise<void> = Promise.resolve();

/** What iOS's call screen shows: the name given to the contact on this phone, never sent anywhere. */
function callerName(channelId: string): string | null {
  const conversation = useConversationsStore.getState().conversations.find((c) => c.channelId === channelId);
  return conversation ? conversationDisplayName(conversation) : null;
}

function newCallId(): string {
  // Random and meaningless: it only ties the signals of one call together.
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function ttlFor(channelId: string): number {
  return (
    useConversationsStore.getState().conversations.find((c) => c.channelId === channelId)?.ttlSeconds ??
    DEFAULT_TTL_SECONDS
  );
}

/**
 * Sends one call signal as an encrypted message.
 *
 * Only the offer is a normal, notifying message: if the other phone is closed,
 * the ordinary push ("new message") is what tells them someone is trying to
 * reach them. Everything after it is silent.
 *
 * The offer also carries text, for builds that predate calls: they ignore the
 * `call` field and show the text, which says what happened. Newer builds never
 * show it.
 */
async function sendSignal(channelId: string, peerUserId: string, call: CallSignal): Promise<void> {
  const ttl = ttlFor(channelId);
  const text = call.kind === 'offer' ? i18n.t('call.olderAppFallback') : '';
  const envelope = await encryptForPeer(peerUserId, encodePayload({ text, call }));
  const row = await sendMessage(channelId, envelope, ttl, {
    silent: call.kind !== 'offer',
    serverTtlSeconds: SIGNAL_SERVER_TTL_SECONDS,
  });
  // Our own row comes back through realtime. It must be recognised as already
  // handled, or ingest would try to decrypt it -- and a phone cannot decrypt
  // what it sent itself.
  useMessagesStore.getState().addMessage(channelId, {
    id: row.id,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    plaintext: '',
    isMine: true,
    isControl: true,
  });
}

function sendSignalQuietly(channelId: string, peerUserId: string, call: CallSignal): void {
  sendSignal(channelId, peerUserId, call).catch((error) => {
    console.warn('[call] could not send signal', call.kind, error);
  });
}

/** One line in the conversation saying a call happened and how it went. */
function logCall(channelId: string, callId: string, outgoing: boolean, startedAt: string, call: StoredCall): void {
  useMessagesStore.getState().addMessage(channelId, {
    id: `call-${callId}`,
    createdAt: startedAt,
    expiresAt: new Date(Date.now() + ttlFor(channelId) * 1000).toISOString(),
    plaintext: '',
    isMine: outgoing,
    notice: 'call',
    call,
  });
}

function clearTimers(): void {
  if (ringTimer) clearTimeout(ringTimer);
  if (dropTimer) clearTimeout(dropTimer);
  ringTimer = null;
  dropTimer = null;
}

function releaseMedia(keepAudioMs = 0): void {
  Vibration.cancel();
  stopRingback();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  try {
    peerConnection?.close();
  } catch {
    // Already closed.
  }
  peerConnection = null;
  pendingOfferSdp = null;
  // Kept a moment longer when a busy signal is still playing in it.
  if (keepAudioMs > 0) setTimeout(() => void stopCallAudio(), keepAudioMs);
  else void stopCallAudio();
}

/**
 * Ends whatever call is in progress on this phone: logs it, tells the other
 * side when asked to, releases the microphone, and leaves the screen up for a
 * moment with the reason.
 */
function finish(outcome: StoredCall['outcome'] | 'ended', notify?: CallSignal['kind']): void {
  const state = useCallStore.getState();
  if (__DEV__) console.log('[call] finish', outcome, 'notify', notify, 'phase', state.phase);
  if (state.phase === 'idle' || !state.callId || !state.channelId || !state.peerUserId) return;

  const durationSeconds = state.connectedAt ? Math.round((Date.now() - state.connectedAt) / 1000) : undefined;
  if (notify) {
    sendSignalQuietly(state.channelId, state.peerUserId, {
      callId: state.callId,
      kind: notify,
      durationSeconds: notify === 'end' ? durationSeconds : undefined,
    });
  }

  const logged: StoredCall['outcome'] = outcome === 'ended' ? (durationSeconds !== undefined ? 'answered' : 'missed') : outcome;
  logCall(state.channelId, state.callId, state.outgoing, callStartedAt ?? new Date().toISOString(), {
    outcome: logged,
    durationSeconds: logged === 'answered' ? durationSeconds : undefined,
  });

  finishedCalls.add(state.callId);
  // The caller hears a busy signal when turned down or when the other person
  // is on another call. The call stays open in iOS until it has played: once
  // CallKit ends the call, its audio session goes, and the tone with it.
  const busyTone = state.outgoing && !notify && (outcome === 'declined' || outcome === 'busy');
  if (busyTone) playBusy();
  // Tell iOS's call screen. A local hang-up goes through CallKit as an action;
  // anything else is reported as having ended, with the reason. When CallKit
  // itself started the ending (the red button on the lock screen), the call
  // is already gone there and this does nothing.
  const endedCallId = state.callId;
  const endReason = notify
    ? 'local'
    : outcome === 'missed'
      ? 'unanswered'
      : outcome === 'declined'
        ? 'declined'
        : outcome === 'failed'
          ? 'failed'
          : 'remote';
  if (busyTone) setTimeout(() => void endCallKitCall(endedCallId, endReason), BUSY_TONE_MS);
  else void endCallKitCall(endedCallId, endReason);
  clearTimers();
  releaseMedia(busyTone ? BUSY_TONE_MS : 0);
  callStartedAt = null;

  useCallStore.setState({
    phase: 'idle',
    callId: null,
    connectedAt: null,
    muted: false,
    speaker: false,
    endedReason: outcome,
  });
  if (clearEndedTimer) clearTimeout(clearEndedTimer);
  clearEndedTimer = setTimeout(() => useCallStore.setState({ endedReason: null, channelId: null, peerUserId: null }), 1800);
}

/** Resolves when candidate gathering is complete, or after a timeout with what there is. */
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(done, ICE_GATHER_TIMEOUT_MS);
    // The `on…` properties rather than addEventListener: the library's type
    // declarations leave its event-target base unresolved, so only these are
    // typed. Each has one user here, so a single handler is enough.
    function done() {
      clearTimeout(timeout);
      pc.onicegatheringstatechange = null;
      resolve();
    }
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
  });
}

async function openConnection(): Promise<RTCPeerConnection> {
  localStream = await mediaDevices.getUserMedia({ audio: true, video: false });
  const pc = new RTCPeerConnection({ iceServers: await relayServers(), iceTransportPolicy: 'relay' });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream!));

  pc.onconnectionstatechange = () => {
    if (peerConnection !== pc) return;
    const state = pc.connectionState;
    if (__DEV__) console.log('[call] connection', state);
    if (state === 'connected') {
      if (dropTimer) clearTimeout(dropTimer);
      dropTimer = null;
      const current = useCallStore.getState();
      if (current.phase !== 'active') {
        Vibration.cancel();
        useCallStore.setState({ phase: 'active', connectedAt: current.connectedAt ?? Date.now() });
        if (current.outgoing && current.callId) void reportOutgoingConnected(current.callId);
        // Applied again now that WebRTC has set up its own audio, which may
        // have reset the route -- but only to put the speaker back on; the
        // earpiece is where a call starts anyway.
        if (current.speaker) void setCallSpeaker(true);
      }
    } else if (state === 'disconnected') {
      // Often a moment's loss of signal; WebRTC recovers by itself. Only a
      // connection that stays down ends the call.
      if (!dropTimer) dropTimer = setTimeout(() => finish('ended', 'end'), RECONNECT_GRACE_MS);
    } else if (state === 'failed') {
      const current = useCallStore.getState();
      finish(current.connectedAt ? 'ended' : 'failed', 'end');
    }
  };

  pc.ontrack = (event: { track?: { kind?: string; enabled?: boolean } }) => {
    if (__DEV__) console.log('[call] remote track', event.track?.kind, 'enabled', event.track?.enabled);
  };

  if (__DEV__) watchStats(pc);

  peerConnection = pc;
  return pc;
}

/**
 * Development only: what is actually flowing, every few seconds, in Metro's
 * log. Packets in and out, and the level of the sound received -- the one way
 * to tell "nothing arrives" from "it arrives and is not played".
 */
function watchStats(pc: RTCPeerConnection): void {
  const timer = setInterval(async () => {
    if (peerConnection !== pc || pc.connectionState === 'closed') {
      clearInterval(timer);
      return;
    }
    try {
      const report = await pc.getStats();
      const parts: string[] = [];
      report.forEach((stat: Record<string, unknown>) => {
        if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
          parts.push(
            `in: ${stat.packetsReceived} pkts, ${stat.bytesReceived} B, level ${stat.audioLevel}, energy ${stat.totalAudioEnergy}, concealed ${stat.concealedSamples}`,
          );
        }
        if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
          parts.push(`out: ${stat.packetsSent} pkts, ${stat.bytesSent} B`);
        }
        if (stat.type === 'media-source' && stat.kind === 'audio') {
          parts.push(`mic level ${stat.audioLevel}, energy ${stat.totalAudioEnergy}`);
        }
      });
      console.log('[call] stats', pc.connectionState, parts.join(' | '));
    } catch (error) {
      console.log('[call] stats failed', error);
    }
  }, 4000);
}

/**
 * Starts a call to the other person in a one-to-one conversation. Throws if
 * the microphone is unavailable; the caller has already asked for permission.
 */
export async function startCall(channelId: string, peerUserId: string): Promise<void> {
  if (useCallStore.getState().phase !== 'idle') return;
  const callId = newCallId();
  if (clearEndedTimer) clearTimeout(clearEndedTimer);
  callStartedAt = new Date().toISOString();
  useCallStore.setState({
    phase: 'outgoing',
    callId,
    channelId,
    peerUserId,
    outgoing: true,
    connectedAt: null,
    muted: false,
    speaker: false,
    endedReason: null,
  });

  try {
    if (hasCallKit) await startOutgoingCall(callId, callerName(channelId));
    await startCallAudio(!hasCallKit);
    const pc = await openConnection();
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    // Hung up while the candidates were being gathered.
    if (useCallStore.getState().callId !== callId) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local description');
    await sendSignal(channelId, peerUserId, { callId, kind: 'offer', sdp });
    if (useCallStore.getState().callId === callId && useCallStore.getState().phase === 'outgoing') startRingback();
    // Wakes the other phone if the app there is closed. Best-effort: when it
    // fails, an open app still rings from the offer itself.
    requestCallPush(channelId, callId).catch((error) => console.warn('[call] push request failed', error));
  } catch (error) {
    console.warn('[call] could not start call', error);
    if (useCallStore.getState().callId === callId) finish('failed');
    throw error;
  }

  ringTimer = setTimeout(() => {
    if (useCallStore.getState().callId === callId && useCallStore.getState().phase === 'outgoing') {
      finish('missed', 'end');
    }
  }, RING_SECONDS * 1000);
}

/** Answers the call that is ringing. */
export async function acceptCall(): Promise<void> {
  const state = useCallStore.getState();
  if (state.phase !== 'incoming' || !state.callId || !state.channelId || !state.peerUserId || !pendingOfferSdp) {
    return;
  }
  const { callId, channelId, peerUserId } = state;
  Vibration.cancel();
  if (ringTimer) clearTimeout(ringTimer);
  ringTimer = null;
  useCallStore.setState({ phase: 'connecting' });

  try {
    await startCallAudio(!hasCallKit);
    const pc = await openConnection();
    await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: pendingOfferSdp }));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await waitForIceGathering(pc);
    if (useCallStore.getState().callId !== callId) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local description');
    // The timer, and the call's recorded length, start when the sound
    // actually connects (onconnectionstatechange), not here: an answer that
    // never connects is a failed call, not a call of a few seconds.
    await sendSignal(channelId, peerUserId, { callId, kind: 'answer', sdp });
  } catch (error) {
    console.warn('[call] could not answer', error);
    if (useCallStore.getState().callId === callId) finish('failed', 'end');
  }
}

/** Turns down the call that is ringing. */
export function declineCall(): void {
  if (useCallStore.getState().phase !== 'incoming') return;
  finish('declined', 'declined');
}

/** Hangs up, or cancels a call that has not been answered yet. */
export function hangUp(): void {
  const { phase } = useCallStore.getState();
  if (phase === 'incoming') return declineCall();
  if (phase === 'outgoing') return finish('missed', 'end');
  finish('ended', 'end');
}

function applyMute(muted: boolean): void {
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
  useCallStore.setState({ muted });
}

export function toggleMute(): void {
  const { muted, callId } = useCallStore.getState();
  applyMute(!muted);
  // Keeps iOS's own call screen showing the same state.
  if (callId) void setCallMuted(callId, !muted);
}

export function toggleSpeaker(): void {
  const speaker = !useCallStore.getState().speaker;
  void setCallSpeaker(speaker);
  useCallStore.setState({ speaker });
}

/**
 * Handles a call signal that arrived in a conversation. Called by ingest for
 * every decrypted message carrying one, in the order they were received.
 */
export function handleCallSignal(
  channelId: string,
  senderUserId: string,
  signal: CallSignal,
  createdAt: string,
): void {
  if (finishedCalls.has(signal.callId)) return;
  const state = useCallStore.getState();
  const isCurrent = state.callId === signal.callId;

  switch (signal.kind) {
    case 'offer': {
      if (!signal.sdp) return;
      const ageSeconds = (Date.now() - Date.parse(createdAt)) / 1000;
      if (ageSeconds > STALE_OFFER_SECONDS) {
        // Found late, by a catch-up fetch: it rang while this phone was away.
        logCall(channelId, signal.callId, false, createdAt, { outcome: 'missed' });
        finishedCalls.add(signal.callId);
        pushedCalls.delete(signal.callId);
        void endCallKitCall(signal.callId, 'unanswered');
        return;
      }
      const conversation = useConversationsStore.getState().conversations.find((c) => c.channelId === channelId);
      if (conversation?.talked === false) {
        // Someone who has never exchanged a message here: not rung, only
        // noted. The caller hears no answer, as from a phone that is off.
        logCall(channelId, signal.callId, false, createdAt, { outcome: 'notRung' });
        finishedCalls.add(signal.callId);
        pushedCalls.delete(signal.callId);
        void endCallKitCall(signal.callId, 'unanswered');
        return;
      }
      if (state.phase !== 'idle') {
        // Already on a call. The other side hears "busy"; this side keeps a
        // record that someone tried.
        sendSignalQuietly(channelId, senderUserId, { callId: signal.callId, kind: 'busy' });
        logCall(channelId, signal.callId, false, createdAt, { outcome: 'missed' });
        finishedCalls.add(signal.callId);
        return;
      }
      if (clearEndedTimer) clearTimeout(clearEndedTimer);
      pendingOfferSdp = signal.sdp;
      callStartedAt = createdAt;
      useCallStore.setState({
        phase: 'incoming',
        callId: signal.callId,
        channelId,
        peerUserId: senderUserId,
        outgoing: false,
        connectedAt: null,
        muted: false,
        speaker: false,
        endedReason: null,
      });
      pushedCalls.delete(signal.callId);
      if (hasCallKit) {
        // iOS rings, on the lock screen too, under the name this phone gave
        // the contact. If a push already reported the call, this only names it.
        void reportIncomingCall(signal.callId, callerName(channelId));
        if (answerOnArrival === signal.callId) {
          answerOnArrival = null;
          void acceptCall();
        }
      } else {
        // Builds without CallKit: a vibration pattern, until answered.
        Vibration.vibrate([0, 600, 800], true);
      }
      const remaining = Math.max(5, RING_SECONDS - ageSeconds) * 1000;
      ringTimer = setTimeout(() => {
        if (useCallStore.getState().callId === signal.callId && useCallStore.getState().phase === 'incoming') {
          finish('missed');
        }
      }, remaining);
      return;
    }
    case 'answer': {
      if (!isCurrent || state.phase !== 'outgoing' || !signal.sdp || !peerConnection) return;
      if (ringTimer) clearTimeout(ringTimer);
      ringTimer = null;
      stopRingback();
      useCallStore.setState({ phase: 'connecting' });
      const pcForAnswer = peerConnection;
      negotiation = negotiation
        .then(() => pcForAnswer.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp! })))
        .catch((error) => {
          console.warn('[call] could not apply answer', error);
          finish('failed', 'end');
        });
      return;
    }
    case 'renegotiate': {
      // The other side changes the call while it is on: here, the demo
      // account's echo arriving as a new stream from Cloudflare's SFU. The
      // connection already exists, so no new network candidates are needed:
      // apply the offer, answer, send the answer back.
      if (!isCurrent || !signal.sdp || !peerConnection || !state.channelId || !state.peerUserId) return;
      const pc = peerConnection;
      const { channelId: currentChannel, peerUserId: currentPeer } = state;
      negotiation = negotiation.then(async () => {
        await pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: signal.sdp! }));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        const sdp = pc.localDescription?.sdp;
        if (!sdp) throw new Error('no local description');
        await sendSignal(currentChannel, currentPeer, { callId: signal.callId, kind: 'renegotiateAnswer', sdp });
      }).catch((error) => console.warn('[call] renegotiation failed', error));
      return;
    }
    case 'renegotiateAnswer':
      // This phone never starts a renegotiation itself; nothing to apply.
      return;
    case 'declined':
      if (isCurrent) finish('declined');
      return;
    case 'busy':
      if (isCurrent) finish('busy');
      return;
    case 'end': {
      if (isCurrent) {
        // The caller gave up before this phone answered: a missed call.
        finish(state.phase === 'incoming' ? 'missed' : 'ended');
      } else if (pushedCalls.has(signal.callId)) {
        // Rang from a push, and ended before the offer was even read here.
        pushedCalls.delete(signal.callId);
        finishedCalls.add(signal.callId);
        void endCallKitCall(signal.callId, 'remote');
        logCall(channelId, signal.callId, false, createdAt, { outcome: 'missed' });
      }
      return;
    }
  }
}

let callKitUnsubscribe: (() => void) | null = null;

/**
 * Connects iOS's call screen (CallKit) and VoIP pushes to the calls here.
 * Called once, when the identity is ready (identity/registerIdentity.ts).
 */
export function startCallKitBridge(onVoipToken: (token: string) => void): void {
  if (!hasCallKit || callKitUnsubscribe) return;
  callKitUnsubscribe = onCallKitEvent((event) => {
    const state = useCallStore.getState();
    if (__DEV__ && event.type !== 'voipToken') console.log('[call] CallKit event', JSON.stringify(event), 'phase', state.phase);
    switch (event.type) {
      case 'voipToken':
        if (event.token) onVoipToken(event.token);
        return;
      case 'incoming': {
        // Rung by a push. The offer is on its way through the ordinary sync;
        // give up if it never comes.
        if (finishedCalls.has(event.callId)) {
          void endCallKitCall(event.callId, 'remote');
          return;
        }
        if (state.callId === event.callId) return;
        pushedCalls.add(event.callId);
        setTimeout(() => {
          if (pushedCalls.has(event.callId) && useCallStore.getState().callId !== event.callId) {
            pushedCalls.delete(event.callId);
            void endCallKitCall(event.callId, 'unanswered');
          }
        }, RING_SECONDS * 1000);
        return;
      }
      case 'answer':
        if (state.callId === event.callId && state.phase === 'incoming') void acceptCall();
        else answerOnArrival = event.callId;
        return;
      case 'end':
        pushedCalls.delete(event.callId);
        if (answerOnArrival === event.callId) answerOnArrival = null;
        if (state.callId === event.callId) hangUp();
        else finishedCalls.add(event.callId);
        return;
      case 'mute':
        if (state.callId === event.callId && state.muted !== event.muted) applyMute(event.muted);
        return;
      case 'reset':
        if (state.phase !== 'idle') finish('failed', 'end');
        return;
      case 'audioActivated':
        // CallKit owns the audio session; WebRTC starts its audio only once
        // told the session is live.
        RTCAudioSession.audioSessionDidActivate();
        return;
      case 'audioDeactivated':
        RTCAudioSession.audioSessionDidDeactivate();
        return;
    }
  });
}
