import AsyncStorage from '@react-native-async-storage/async-storage';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabaseClient';

/**
 * Public notices, shown as a card at the top of the conversation list
 * (supabase/migrations/0036_announcements.sql).
 *
 * Read with the anon key alone, deliberately not through the supabase client:
 * the client attaches the account's session to every request, and then the
 * hosting log would hold "this account asked for the notices". Asked this way
 * it holds an IP and nothing else, and every phone gets the same answer.
 *
 * Which notices were dismissed is kept here, on the phone, and never sent.
 */
export type Announcement = {
  id: string;
  title: string;
  body: string;
  actionLabel?: string;
  actionUrl?: string;
};

type Row = {
  id: string;
  starts_at: string;
  min_app_version: string | null;
  [key: string]: string | null;
};

const DISMISSED_KEY = 'announcements.dismissed';

/** Our published pages only, as the table's own constraint insists. */
const ALLOWED_PREFIX = 'https://xeixos-corp.github.io/Seixo-Legal/';

/**
 * The newest notice for this language and app version that has not been
 * dismissed on this phone, or null. Never throws: a notice is a nicety, and a
 * failure to read one must not show up as an error anywhere.
 */
export async function fetchCurrentAnnouncement(
  language: string,
  appVersion: string,
): Promise<Announcement | null> {
  try {
    const lang = language === 'en' || language === 'es' ? language : 'pt';
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/announcements?select=*&order=starts_at.desc&limit=10`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          'Cache-Control': 'no-store',
        },
      },
    );
    if (!response.ok) return null;
    const rows = (await response.json()) as Row[];
    const dismissed = await readDismissed();

    for (const row of rows) {
      if (dismissed.has(row.id)) continue;
      if (row.min_app_version && compareVersions(appVersion, row.min_app_version) < 0) continue;
      const title = row[`title_${lang}`];
      const body = row[`body_${lang}`];
      if (!title || !body) continue;
      const url = row[`action_url_${lang}`] ?? undefined;
      const label = row[`action_label_${lang}`] ?? undefined;
      const safeUrl = url && url.startsWith(ALLOWED_PREFIX) ? url : undefined;
      return {
        id: row.id,
        title,
        body,
        actionLabel: safeUrl ? label : undefined,
        actionUrl: safeUrl,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function dismissAnnouncement(id: string): Promise<void> {
  const dismissed = await readDismissed();
  dismissed.add(id);
  // Kept bounded: a notice ends anyway, and its id is useless after that.
  const kept = [...dismissed].slice(-50);
  await AsyncStorage.setItem(DISMISSED_KEY, JSON.stringify(kept));
}

async function readDismissed(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(DISMISSED_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/** "1.16.0" against "1.15.2": negative, zero or positive, numerically. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
