// Attaches a recovery backup's derived credentials to the caller's own
// account, and marks the address confirmed in the same step.
//
// Why this function exists at all. Restoring a backup has to land in the
// *same* account, or contacts would go on writing to a user id nobody can
// read. The recovery phrase therefore derives an email/password pair
// (packages/signal-native/rust/src/backup.rs), and that pair has to be
// attached to the account. Doing it from the client with `updateUser` leaves
// the address pending an email confirmation that can never arrive: the
// address is on `@seixo.invalid`, a domain reserved by RFC 2606 precisely so
// that it never resolves. Confirming it needs the Admin API's
// `email_confirm`, which needs the service-role key, which must never reach
// a client. Hence a function.
//
// The alternative was turning off "Confirm email" for the whole project. That
// works, but it disables a protection everywhere to solve a problem in one
// place. This keeps the project setting untouched and auto-confirms only
// these generated addresses.
//
// NOTHING HERE MAY EVER LOG THE REQUEST BODY. It carries the password half of
// the phrase in the clear -- the one moment it exists outside the device --
// and Edge Function logs are retained. There is no console.log in this file
// on purpose; do not add one.
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY are injected
// into every Edge Function's environment by Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";

// The exact shape derive_backup_credentials produces: 32 hex characters on
// the reserved domain. Checked rather than trusted, so this function cannot
// be turned into a way to attach an arbitrary real address to an account --
// which would let someone squat a stranger's email, or make our project send
// confirmation mail to people who never asked for it.
const DERIVED_EMAIL = /^[0-9a-f]{32}@seixo\.invalid$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) {
    return json({ error: "missing authorization header" }, 401);
  }

  let email: unknown;
  let password: unknown;
  try {
    ({ email, password } = await req.json());
  } catch {
    return json({ error: "invalid request body" }, 400);
  }

  if (typeof email !== "string" || !DERIVED_EMAIL.test(email)) {
    return json({ error: "not a derived recovery address" }, 400);
  }
  // 32 bytes of base64. Long enough that a short or empty password -- which
  // would make the account trivially enterable by anyone -- is refused here
  // rather than accepted quietly.
  if (typeof password !== "string" || password.length < 40) {
    return json({ error: "invalid recovery secret" }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // The account acted on is the caller's own, resolved from their own
  // session. A client-supplied user id would let anyone attach credentials
  // they know to somebody else's account -- which is to say, take it over.
  const callerClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await callerClient.auth.getUser();
  if (userError || !userData.user) {
    return json({ error: "invalid session" }, 401);
  }

  const adminClient = createClient(supabaseUrl, serviceRoleKey);
  const { data: updated, error: updateError } = await adminClient.auth.admin
    .updateUserById(userData.user.id, {
      email,
      password,
      // The whole reason this runs server-side. Without it the address sits
      // unconfirmed and the restore fails on a phone that no longer has the
      // identity to try again from.
      email_confirm: true,
    });

  if (updateError) {
    return json({ error: updateError.message }, 500);
  }

  // Reported back so the app can verify rather than assume, and refuse to
  // write a backup file that would not restore.
  return json(
    {
      ok: true,
      email: updated.user?.email ?? null,
      confirmed: Boolean(updated.user?.email_confirmed_at),
    },
    200,
  );
});
