import type { RecordingOptions } from 'expo-audio';
import { IOSOutputFormat, AudioQuality } from 'expo-audio';

/**
 * Speech, not music: mono, 16 kHz, 24 kbps AAC.
 *
 * The presets that ship with expo-audio are stereo 44.1 kHz at 128 kbps,
 * which is ten times the size for no audible gain on a voice message -- and
 * size matters more than usual here, because the recording has to fit inside
 * the encrypted message itself (see messaging/payload.ts for why it is not
 * stored as a separate file).
 *
 * A constant bitrate is chosen deliberately. Variable bitrate encodes louder
 * and more complex passages larger, which leaks the rhythm of speech into the
 * file size -- there is published work recovering phrases from exactly that in
 * encrypted VoIP. Constant bitrate makes size a function of duration only,
 * and the padding in payload.ts then blurs the duration.
 */
export const VOICE_RECORDING_OPTIONS: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 24000,
  android: {
    outputFormat: 'mpeg4',
    audioEncoder: 'aac',
  },
  ios: {
    outputFormat: IOSOutputFormat.MPEG4AAC,
    audioQuality: AudioQuality.MEDIUM,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
  },
  web: {
    mimeType: 'audio/webm',
    bitsPerSecond: 24000,
  },
};

/**
 * 60 seconds. The cap exists because the audio travels inside the message
 * row: a minute is about 180 KB, which Postgres handles without complaint,
 * while five minutes would not be reasonable.
 */
export const MAX_VOICE_DURATION_MS = 60_000;

/** How long the server holds a voice message waiting for delivery. */
export const VOICE_SERVER_TTL_SECONDS = 24 * 60 * 60;

/**
 * The flattened, iOS-shaped options that `AudioModule.AudioRecorder` expects.
 *
 * `useAudioRecorder` does this conversion internally, but the hook builds a
 * recorder as soon as the screen mounts -- and on iOS the existence of a
 * recorder is enough to put the audio session into a record-and-play mode,
 * where playback is routed away from Bluetooth output. Voice messages then
 * play to nothing at all on AirPods, even when no recording has happened.
 *
 * Creating the recorder only while actually recording removes the cause
 * rather than trying to undo it afterwards. That means doing this conversion
 * here, since the package does not export it.
 */
export function iosRecorderOptions(): Record<string, unknown> {
  const { extension, sampleRate, numberOfChannels, bitRate, ios } = VOICE_RECORDING_OPTIONS;
  return { extension, sampleRate, numberOfChannels, bitRate, isMeteringEnabled: false, ...ios };
}
