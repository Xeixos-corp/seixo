// Acts on a report, from the page linked in the developer's email.
//
// POST { r: report id, t: token } returns the report so the page can show it.
// POST { r, t, action } with action 'ban' | 'dismiss' | 'lift' carries out
// the decision through moderate_report (migration 0029).
//
// The token was made by report-notify and only its SHA-256 is stored; a
// report id without the matching token does nothing. Anyone holding a link
// can act on that one report and nothing else.
//
// Called from the browser, on the project's GitHub Pages origin, so it
// answers CORS for that origin only. Logs nothing about reports.

import { createClient } from "jsr:@supabase/supabase-js@2";

const ORIGIN = "https://xeixos-corp.github.io";
const CORS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Vary": "Origin",
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let body: { r?: string; t?: string; action?: string } = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad request" }, 400);
  }
  const { r, t, action } = body;
  if (!r || !t || !/^[0-9a-f-]{36}$/.test(r) || !/^[0-9a-f]{64}$/.test(t)) {
    return json({ error: "not authorised" }, 401);
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: report } = await admin
    .from("reports")
    .select("id, created_at, reported_user_id, content, status, action_token_hash, channel_id")
    .eq("id", r)
    .maybeSingle();
  if (!report || !report.action_token_hash || report.action_token_hash !== (await sha256Hex(t))) {
    return json({ error: "not authorised" }, 401);
  }

  if (!action) {
    const [{ data: others }, { data: restriction }] = await Promise.all([
      admin.from("reports").select("reporter_id").eq("reported_user_id", report.reported_user_id).neq(
        "status",
        "dismissed",
      ),
      admin.from("account_restrictions").select("state").eq("user_id", report.reported_user_id)
        .maybeSingle(),
    ]);
    return json({
      report: {
        createdAt: report.created_at,
        reportedUserId: report.reported_user_id,
        content: report.content,
        status: report.status,
        reporters: new Set((others ?? []).map((row) => row.reporter_id)).size,
        restriction: restriction?.state ?? null,
      },
    }, 200);
  }

  if (!["ban", "dismiss", "lift"].includes(action)) return json({ error: "bad request" }, 400);

  const { data: result, error } = await admin.rpc("moderate_report", { report: r, action });
  if (error) return json({ error: "failed" }, 500);
  return json({ result }, 200);
});
