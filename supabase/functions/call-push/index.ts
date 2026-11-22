// Wakes the other phone in a conversation with a VoIP push, so a voice call
// rings even when Seixo is closed there.
//
// The caller's phone calls this right after sending the call's offer as an
// ordinary encrypted message (app/src/calls/callPush.ts). The push carries
// only the call's id, a random number made on the caller's phone; the woken
// app then reads the offer through its normal sync and names the caller from
// its own contacts. Apple sees a push to a device and nothing else.
//
// What this function learns, and does not keep: that the authenticated
// caller asked for the other member of this conversation to be rung. Nothing
// is written to the database. The hosting platform logs the request, as it
// logs every request (see the privacy policy).
//
// Secrets (set in the Supabase dashboard, never in this repository):
//   APNS_KEY_P8   the contents of the AuthKey_XXXXXXXXXX.p8 file
//   APNS_KEY_ID   its 10-character key id
//   APNS_TEAM_ID  the Apple developer team id
//
// See supabase/migrations/0038_voip_tokens.sql for who may be rung.

import { createClient } from "jsr:@supabase/supabase-js@2";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * The provider token APNs wants: a JWT signed with the .p8 key (ES256).
 *
 * Apple rejects tokens older than an hour and also complains when a new one
 * is made more often than every 20 minutes, so one is kept for 50 minutes
 * while this function stays warm.
 */
let cachedJwt: { value: string; madeAt: number } | null = null;

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  raw.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function providerToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.madeAt < 50 * 60) return cachedJwt.value;

  const keyId = Deno.env.get("APNS_KEY_ID")!;
  const teamId = Deno.env.get("APNS_TEAM_ID")!;
  const pem = Deno.env.get("APNS_KEY_P8")!;
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);

  const unsigned = `${base64url(JSON.stringify({ alg: "ES256", kid: keyId }))}.${base64url(
    JSON.stringify({ iss: teamId, iat: now }),
  )}`;
  // WebCrypto's ECDSA signature is already r||s, the form JWT expects.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(unsigned)),
  );
  const value = `${unsigned}.${base64url(signature)}`;
  cachedJwt = { value, madeAt: now };
  return value;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return json(401, { error: "missing authorization header" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // The caller is who their own session says, never a field in the body.
  const callerClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) return json(401, { error: "invalid session" });

  let body: { channel_id?: unknown; call_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(400, { error: "invalid body" });
  }
  const channelId = typeof body.channel_id === "string" ? body.channel_id : "";
  const callId = typeof body.call_id === "string" ? body.call_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(channelId) || !/^[0-9a-f]{32}$/.test(callId)) {
    return json(400, { error: "invalid channel or call id" });
  }

  if (!Deno.env.get("APNS_KEY_P8") || !Deno.env.get("APNS_KEY_ID") || !Deno.env.get("APNS_TEAM_ID")) {
    return json(503, { error: "calls push not configured" });
  }

  const admin = createClient(supabaseUrl, serviceRoleKey);
  const { data: targets, error: targetError } = await admin.rpc("call_push_target", {
    caller: userData.user.id,
    channel: channelId,
  });
  if (targetError) return json(500, { error: "lookup failed" });
  const target = (targets ?? [])[0] as { token: string; topic: string; sandbox: boolean } | undefined;
  // Not a member, not a two-person conversation, blocked, or the other phone
  // has no VoIP token: all look the same from outside, on purpose.
  if (!target) return json(200, { sent: false });

  const host = target.sandbox ? "api.sandbox.push.apple.com" : "api.push.apple.com";
  const response = await fetch(`https://${host}/3/device/${target.token}`, {
    method: "POST",
    headers: {
      authorization: `bearer ${await providerToken()}`,
      "apns-topic": target.topic,
      "apns-push-type": "voip",
      "apns-priority": "10",
      // A call that could not be delivered within 40 seconds has stopped
      // ringing on the caller's side; better never than late.
      "apns-expiration": String(Math.floor(Date.now() / 1000) + 40),
    },
    body: JSON.stringify({ c: callId }),
  });

  if (response.status === 200) return json(200, { sent: true });

  const reason = await response.json().then((r) => r?.reason).catch(() => undefined);
  // A token Apple no longer recognises is removed, so it is not tried again.
  if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
    await admin.from("voip_tokens").delete().eq("token", target.token);
  }
  console.error("apns refused", response.status, reason);
  return json(200, { sent: false });
});
