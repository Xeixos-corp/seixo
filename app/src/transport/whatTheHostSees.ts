import { supabase } from './supabaseClient';

/**
 * What the hosting layer saw of one request, as the Edge Function
 * `what-the-host-sees` hands it back. Every field but the IP may be missing:
 * the function returns only what the edge's headers carried and never looks
 * anything up elsewhere.
 */
export type WhatTheHostSees = {
  ip: string | null;
  /** ISO 3166 code, such as "PT". */
  country: string | null;
  /** The request came through Tor, so there is no country to show. */
  tor: boolean;
  city: string | null;
  region: string | null;
  postalCode: string | null;
};

/**
 * Asks, once, on the person's own press. Not cached and not stored: leaving
 * the screen forgets it, as with the rest of the footprint.
 */
export async function fetchWhatTheHostSees(): Promise<WhatTheHostSees> {
  const { data, error } = await supabase.functions.invoke('what-the-host-sees', { method: 'GET' });
  if (error) throw error;
  const body = (data ?? {}) as Partial<WhatTheHostSees>;
  return {
    ip: body.ip ?? null,
    country: body.country ?? null,
    tor: body.tor === true,
    city: body.city ?? null,
    region: body.region ?? null,
    postalCode: body.postalCode ?? null,
  };
}
