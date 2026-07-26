// App Store Review Guideline 5.1.1(v): "If your app supports account
// creation, you must also offer account deletion within the app." Anonymous
// sign-in (see app/src/transport/identities.ts) still counts as account
// creation for this purpose.
//
// Deleting `auth.users` requires the Admin API (service-role key), which
// must never reach the client — this Edge Function is the only place that
// key exists. It verifies the caller's own JWT first (never trusts a
// client-supplied user id for something this destructive), then deletes
// exactly that caller's own auth.users row. Everything else — identities,
// signed_prekeys, one_time_prekeys, channel_members, blocked_peers — is
// already wired with `on delete cascade` (see supabase/migrations/0001_init.sql,
// 0007_blocking.sql), so one delete on auth.users cleans up the whole
// account server-side. It does NOT touch other users' channels/messages
// that this account was a member of — those age out via the existing TTL
// purge (0002_pg_cron_ttl.sql) like any other conversation.
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are
// automatically injected into every Edge Function's environment by
// Supabase — nothing to configure.

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return new Response(JSON.stringify({ error: "missing authorization header" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Resolve the caller's own user id from their own session — a
  // client-supplied id in the request body would let anyone delete anyone
  // else's account.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    return new Response(JSON.stringify({ error: "invalid session" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { error: deleteError } = await adminClient.auth.admin.deleteUser(userData.user.id);
  if (deleteError) {
    return new Response(JSON.stringify({ error: deleteError.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
