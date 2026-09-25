// Emails the developer when someone reports a message or a person.
//
// Called by the database (migration 0029, trigger after_report) through
// pg_net, with a secret that lives only in the vault; this function does not
// know it and asks the database to check it (check_reports_secret).
//
// The email says only that a report arrived, how many different people have
// reported that account and whether it is now suspended -- never the reported
// text, never an account id. Those pass through the mail provider and sit in
// a mailbox; the page the link opens fetches them from the database instead,
// and only for whoever holds the link. The link carries a one-time token made
// here: only its SHA-256 is stored, so the database never holds anything that
// could act on a report by itself.
//
// The link opens a page on the project's GitHub Pages site (moderar.html) and
// puts the report id and token in the URL *fragment*, which browsers never
// send to a server: GitHub's logs see only that the page was opened. The page
// then calls the `moderate` function. A page rather than a link that acts
// directly, because mail services fetch links in advance to check them, and
// that must never be able to expel anyone.
//
// Logs nothing about the report's content or the people in it.
//
// Needs two secrets set on the project (Edge Functions > Secrets):
//   RESEND_API_KEY   -- the developer's Resend key
//   REPORT_EMAIL_TO  -- where reports go (the Resend account's own address)

import { createClient } from "jsr:@supabase/supabase-js@2";

const PAGE = "https://xeixos-corp.github.io/Seixo-Legal/moderar.html";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const secret = req.headers.get("x-report-secret");
  if (!secret) return json({ error: "not authorised" }, 401);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: allowed } = await admin.rpc("check_reports_secret", { secret });
  if (allowed !== true) return json({ error: "not authorised" }, 401);

  let reportId: string | undefined;
  try {
    reportId = (await req.json())?.report_id;
  } catch {
    // fall through
  }
  if (!reportId) return json({ error: "bad request" }, 400);

  const { data: report, error } = await admin
    .from("reports")
    .select("id, reported_user_id, channel_id")
    .eq("id", reportId)
    .maybeSingle();
  if (error || !report) return json({ error: "not found" }, 404);

  const [{ data: others }, { data: restriction }, { data: channel }] = await Promise.all([
    admin
      .from("reports")
      .select("reporter_id")
      .eq("reported_user_id", report.reported_user_id)
      .neq("status", "dismissed"),
    admin
      .from("account_restrictions")
      .select("state")
      .eq("user_id", report.reported_user_id)
      .maybeSingle(),
    report.channel_id
      ? admin.from("channels").select("kind").eq("id", report.channel_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);
  const reporters = new Set((others ?? []).map((row) => row.reporter_id)).size;

  const token = crypto.getRandomValues(new Uint8Array(32));
  const tokenHex = hex(token);
  const tokenHash = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(tokenHex)));
  await admin.from("reports").update({ action_token_hash: tokenHash }).eq("id", report.id);

  const link = `${PAGE}#r=${report.id}&t=${tokenHex}`;
  const state =
    restriction?.state === "banned"
      ? "já expulsa"
      : restriction?.state === "suspended"
      ? "SUSPENSA automaticamente (3 ou mais pessoas denunciaram)"
      : "activa";
  const where = channel?.kind === "group" ? "num grupo" : "numa conversa a dois";

  const text = [
    `Nova denúncia no Seixo, ${where}.`,
    `Pessoas diferentes que denunciaram esta conta: ${reporters}`,
    `Estado da conta: ${state}`,
    "",
    "Tens 24 horas para decidir. Abre esta ligação para ver o que foi denunciado e expulsar a conta ou rejeitar a denúncia:",
    link,
  ].join("\n");

  const html = `<p>Nova denúncia no Seixo, ${where}.</p>
<p>Pessoas diferentes que denunciaram esta conta: <strong>${reporters}</strong><br>
Estado da conta: <strong>${escapeHtml(state)}</strong></p>
<p>Tens 24 horas para decidir. O que foi denunciado aparece na página, não neste email.</p>
<p><a href="${link}" style="background:#c9785b;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;display:inline-block">Ver e decidir</a></p>`;

  const key = Deno.env.get("RESEND_API_KEY");
  const to = Deno.env.get("REPORT_EMAIL_TO");
  if (!key || !to) return json({ error: "email not configured" }, 500);

  const sent = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "Seixo <onboarding@resend.dev>",
      to: [to],
      subject: reporters >= 3 ? "Seixo: denúncia — conta suspensa" : "Seixo: nova denúncia",
      text,
      html,
    }),
  });
  if (!sent.ok) {
    console.error("[report-notify] email refused", sent.status);
    return json({ error: "email failed" }, 502);
  }
  return json({ ok: true }, 200);
});
