import { Linking } from 'react-native';
import * as Location from 'expo-location';

/**
 * Sending a location, once, and opening a received one in a map.
 *
 * The position is read only when the person asks to send it, and only while
 * the app is in use: there is no background permission and nothing that
 * watches where anyone goes (app.json declares the "when in use" string only).
 * It travels inside the encrypted message; the server never sees it.
 */

export type CurrentLocation =
  | { kind: 'ok'; latitude: number; longitude: number; accuracyMeters?: number }
  | { kind: 'denied'; canAskAgain: boolean }
  | { kind: 'unavailable' };

/**
 * Asks for permission if it was never asked, then reads one position.
 *
 * The refusal is passed up rather than handled here, so the screen can offer
 * the way to Settings only after an earlier refusal, never in answer to one
 * just given: the same rule as the camera and the microphone.
 */
export async function readCurrentLocation(): Promise<CurrentLocation> {
  const before = await Location.getForegroundPermissionsAsync();
  const permission = before.granted ? before : await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return { kind: 'denied', canAskAgain: before.canAskAgain };

  try {
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    return {
      kind: 'ok',
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracyMeters: position.coords.accuracy ?? undefined,
    };
  } catch {
    // Location services off, or no fix indoors in time.
    return { kind: 'unavailable' };
  }
}

export type MapApp = 'apple' | 'google' | 'waze';

/**
 * The map apps worth offering on this phone: Apple Maps always, Google Maps
 * and Waze only when installed (their schemes are declared in app.json, which
 * iOS requires before an app may ask). No web fallback on purpose: a browser
 * would carry whatever cookies it holds to the map's site.
 */
export async function availableMapApps(): Promise<MapApp[]> {
  const apps: MapApp[] = ['apple'];
  if (await Linking.canOpenURL('comgooglemaps://').catch(() => false)) apps.push('google');
  if (await Linking.canOpenURL('waze://').catch(() => false)) apps.push('waze');
  return apps;
}

/**
 * Only at this moment does a map company learn the place: the one the
 * recipient chose, because they chose to look.
 */
export async function openInMap(app: MapApp, latitude: number, longitude: number): Promise<void> {
  const ll = `${latitude},${longitude}`;
  const url =
    app === 'google'
      ? `comgooglemaps://?q=${ll}&center=${ll}&zoom=16`
      : app === 'waze'
        ? `waze://?ll=${ll}`
        : `maps://?ll=${ll}&q=${encodeURIComponent('Seixo')}`;
  await Linking.openURL(url);
}

/** "38,7223 N · 9,1393 W", in the reader's own number format. */
export function formatCoordinates(latitude: number, longitude: number, language: string): string {
  const format = (value: number) =>
    Math.abs(value).toLocaleString(language, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  return `${format(latitude)} ${latitude >= 0 ? 'N' : 'S'} · ${format(longitude)} ${longitude >= 0 ? 'E' : 'W'}`;
}

/** Plain decimal coordinates, for copying into anything. */
export function plainCoordinates(latitude: number, longitude: number): string {
  return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}
