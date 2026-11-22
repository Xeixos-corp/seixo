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
import { useMessagesStore, type StoredCall } from '../store/messagesStore';
import { useConversationsStore, DEFAULT_TTL_SECONDS } from '../store/conversationsStore';
import { startCallAudio, stopCallAudio, setCallSpeaker } from '../../modules/audio-session-expo/src';

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
 * STUN only, for now: it tells each phone its own public address so a direct
 * path can be tried. It sees that address and nothing else, and needs no
 * account. The TURN relay (Cloudflare) replaces direct paths before release.
 */
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];

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
/** Call ids already finished on this phone, so a late signal cannot revive one. */
const finishedCalls = new Set<string>();

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

function releaseMedia(): void {
  Vibration.cancel();
  localStream?.getTracks().forEach((track) => track.stop());
  localStream = null;
  try {
    peerConnection?.close();
  } catch {
    // Already closed.
  }
  peerConnection = null;
  pendingOfferSdp = null;
  void stopCallAudio();
}

/**
 * Ends whatever call is in progress on this phone: logs it, tells the other
 * side when asked to, releases the microphone, and leaves the screen up for a
 * moment with the reason.
 */
function finish(outcome: StoredCall['outcome'] | 'ended', notify?: CallSignal['kind']): void {
  const state = useCallStore.getState();
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
  clearTimers();
  releaseMedia();
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
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream!));

  pc.onconnectionstatechange = () => {
    if (peerConnection !== pc) return;
    const state = pc.connectionState;
    if (state === 'connected') {
      if (dropTimer) clearTimeout(dropTimer);
      dropTimer = null;
      const current = useCallStore.getState();
      if (current.phase !== 'active') {
        Vibration.cancel();
        useCallStore.setState({ phase: 'active', connectedAt: current.connectedAt ?? Date.now() });
        // Applied again now that WebRTC has set up its own audio, which may
        // have reset the route.
        void setCallSpeaker(current.speaker);
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
    await startCallAudio();
    const pc = await openConnection();
    const offer = await pc.createOffer({});
    await pc.setLocalDescription(offer);
    await waitForIceGathering(pc);
    // Hung up while the candidates were being gathered.
    if (useCallStore.getState().callId !== callId) return;
    const sdp = pc.localDescription?.sdp;
    if (!sdp) throw new Error('no local description');
    await sendSignal(channelId, peerUserId, { callId, kind: 'offer', sdp });
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
    await startCallAudio();
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

export function toggleMute(): void {
  const muted = !useCallStore.getState().muted;
  localStream?.getAudioTracks().forEach((track) => {
    track.enabled = !muted;
  });
  useCallStore.setState({ muted });
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
      // A pattern, repeated, until answered or given up on. A ringtone comes
      // with CallKit in a later phase.
      Vibration.vibrate([0, 600, 800], true);
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
      useCallStore.setState({ phase: 'connecting' });
      peerConnection
        .setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: signal.sdp }))
        .catch((error) => {
          console.warn('[call] could not apply answer', error);
          finish('failed', 'end');
        });
      return;
    }
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
      }
      return;
    }
  }
}
