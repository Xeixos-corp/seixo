/**
 * The notification sounds this build carries.
 *
 * The files are bundled into the app by the expo-notifications config plugin
 * (app.json), and a push carries only the file name for iOS to look up in the
 * installed app. So this list and the plugin's list must agree, and a sound
 * that is not in both is simply a notification with no sound.
 *
 * `require` rather than a path string: Metro resolves it at build time, which
 * is what makes the same file available to the preview player below. A name
 * built at runtime would not be bundled at all.
 *
 * They are synthesised, not recorded -- see scripts/generate-notification-sounds.py.
 */
export type NotificationSound = {
  /** What the server puts in the push payload, and what iOS looks for. */
  file: string;
  /** Key under settings.sounds.* in the translations. */
  labelKey: string;
  /** The bundled asset, for playing a preview in Settings. */
  asset: number | null;
};

/** The phone's ordinary notification sound. Carries no file of its own. */
export const DEFAULT_SOUND = 'default';

export const NOTIFICATION_SOUNDS: NotificationSound[] = [
  { file: DEFAULT_SOUND, labelKey: 'default', asset: null },
  { file: 'sino.wav', labelKey: 'sino', asset: require('../../assets/sounds/sino.wav') },
  { file: 'toque.wav', labelKey: 'toque', asset: require('../../assets/sounds/toque.wav') },
  { file: 'duplo.wav', labelKey: 'duplo', asset: require('../../assets/sounds/duplo.wav') },
  { file: 'grave.wav', labelKey: 'grave', asset: require('../../assets/sounds/grave.wav') },
];

export function isKnownSound(file: string): boolean {
  return NOTIFICATION_SOUNDS.some((sound) => sound.file === file);
}
