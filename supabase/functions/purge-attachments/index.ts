// Deletes encrypted images whose message no longer exists.
//
// Why a function rather than a trigger. Deleting a row from storage.objects in
// SQL is refused by Supabase's own storage.protect_delete(), and rightly: the
// row is only the index, the bytes live in a separate object store, and
// removing the row would leave the encrypted file behind where nobody knows it
// exists. Only the Storage API removes both, and the Storage API needs the
// service-role key, which only an Edge Function holds.
//
// Called every minute by pg_cron through pg_net (migration 0027), and only on
// minutes when there is something to delete.
//
// Authentication. The caller sends a secret that was created inside the
// database and has never left it -- it is not in this repository, not in this
// function's environment, not in anybody's terminal. This function does not
// know it either; it passes what it received to claim_expired_attachments,
// which compares it with the vault and refuses if it does not match. Someone
// who found this URL could at worst trigger a sweep the database would have
// run a minute later anyway, and only with the secret.
//
// Deliberately says nothing in its logs about which objects it removed. Object
// names are message ids; a log line listing them would be a record, kept by
// the function runtime, of which messages carried images.
//
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected into every Edge
// Function's environment by Supabase.

import { createClient } from "jsr:@supabase/supabase-js@2";

const BUCKET = "attachments";
const BATCH = 100;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }

  const secret = req.headers.get("x-purge-secret");
  if (!secret) {
    return json({ error: "not authorised" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  // One call both checks the secret and returns what to delete. A wrong secret
  // raises inside the database, which surfaces here as an error -- reported as
  // "not authorised" and nothing more, so a caller learns nothing by probing.
  const { data, error } = await admin.rpc("claim_expired_attachments", {
    secret,
    max_count: BATCH,
  });
  if (error) {
    return json({ error: "not authorised" }, 401);
  }

  // A `setof text` comes back as an array of strings; tolerate an array of
  // single-column rows as well, so a change in how PostgREST shapes scalar
  // sets cannot silently turn every name into "[object Object]".
  const names = (Array.isArray(data) ? data : [])
    .map((row: unknown) =>
      typeof row === "string"
        ? row
        : row && typeof row === "object"
        ? String(Object.values(row as Record<string, unknown>)[0] ?? "")
        : ""
    )
    .filter((name: string) => name.length > 0);

  if (names.length === 0) {
    return json({ removed: 0 }, 200);
  }

  const { error: removeError } = await admin.storage.from(BUCKET).remove(names);
  if (removeError) {
    // Left for the next minute's run, which will claim the same names again.
    return json({ error: "remove failed" }, 500);
  }

  return json({ removed: names.length }, 200);
});
