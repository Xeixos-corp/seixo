// Hands a phone short-lived credentials for Cloudflare's TURN relay, for one
// side of one voice call.
//
// Calls always go through the relay, never directly between the phones, so
// neither person learns the other's IP address (app/src/calls/callManager.ts).
// The relay needs credentials; the long-lived TURN key that makes them stays
// here, in this function's secrets, and never reaches an app.
//
// What this function learns: that the authenticated account is setting up a
// call, now. It keeps none of it, apart from adding one to this month's total
// (supabase/migrations/0039_turn_issuance.sql), which is what stops calls from
// ever running past Cloudflare's free allowance: past the ceiling, no more
// credentials until the month turns over.
//
// Secrets (Supabase dashboard): CF_TURN_KEY_ID, CF_TURN_API_TOKEN.
// Optional: TURN_MONTHLY_CEILING (default 10000 credentials, about 5,000
// calls).
//
// The defaults make going past Cloudflare's free 1,000 GB impossible, not
// merely unlikely: one side of a voice call receives about 22 MB an hour, and
// a credential stops working after two hours, so 10,000 credentials can carry
// at most about 450 GB in a month. Cloudflare holds a payment method for
// anything beyond the free allowance (2026-11-23); this is what keeps it from
// ever being used. Raise the ceiling only on purpose.

import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * Two hours: a call longer than that loses its relay. Part of the cost
 * ceiling above, so not to be lengthened on its own.
 */
const CREDENTIAL_TTL_SECONDS = 2 * 60 * 60;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "missing authorization header" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const keyId = Deno.env.get("CF_TURN_KEY_ID");
  const apiToken = Deno.env.get("CF_TURN_API_TOKEN");
  if (!keyId || !apiToken) return json(503, { error: "relay not configured" });

  // Only accounts can ask, and anonymous visitors cannot: a session is required.
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "invalid session" });

  const ceiling = Number(Deno.env.get("TURN_MONTHLY_CEILING") ?? "10000");
  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: allowed, error: countError } = await admin.rpc("take_turn_credential", { ceiling });
  if (countError) return json(500, { error: "count failed" });
  if (allowed !== true) return json(429, { error: "monthly relay allowance used up" });

  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: CREDENTIAL_TTL_SECONDS }),
    },
  );
  if (!response.ok) {
    console.error("cloudflare refused", response.status);
    return json(502, { error: "relay unavailable" });
  }
  const body = await response.json();
  const servers = Array.isArray(body?.iceServers) ? body.iceServers : body?.iceServers ? [body.iceServers] : [];
  // Cloudflare lists port 53 too, which many networks block; with candidates
  // gathered up front, a blocked port only adds waiting. Plain STUN is dropped
  // as well: the app uses the relay only.
  const iceServers = servers
    .map((server: { urls: string | string[]; username?: string; credential?: string }) => ({
      ...server,
      urls: (Array.isArray(server.urls) ? server.urls : [server.urls]).filter(
        (url) => url.startsWith("turn") && !/:53(\?|$)/.test(url),
      ),
    }))
    .filter((server: { urls: string[] }) => server.urls.length > 0);

  return json(200, { iceServers });
});
