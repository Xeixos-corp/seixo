// The automatic demo account's phone. See migration 0032 for why it exists
// and packages/demo-account for the Signal Protocol side.
//
// Two actions, both behind the shared secret in the vault (checked by the
// database, never known here):
//
//   setup  creates the account once: an auth user, its identity and prekeys,
//          the state row. Run by hand; returns the account's id.
//   drain  answers whatever is waiting in demo_account_inbox. Called by the
//          trigger on every message sent to the account, and by a retry job.
//
// It runs as the account itself (signed in with its password), so every
// message it sends passes the same policies and triggers as a phone's: the
// other person is notified, a block applies, a restriction would too.
//
// Logs nothing about what it reads or who wrote. The WebAssembly and the photo
// come from this repository at a fixed commit and are checked against their
// SHA-256 before use, so nobody who can change GitHub can change what runs.

import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  add_one_time_prekeys,
  create,
  decrypt,
  encrypt,
  initSync,
  seal_attachment,
} from "./demo_account.js";

const ASSETS =
  "https://raw.githubusercontent.com/Xeixos-corp/seixo/__COMMIT__/supabase/functions/demo-account/assets/";
const WASM_SHA256 = "8e8a47dac47ed17c456786b2cfdfaa054bb16024ea8cf2e6223dbb8f3d8bcb89";
const PHOTO_SHA256 = "aa4c87d792376be865c33b739c971fbdecf9689bf0771ebb1da1165d4326268c";
const PHOTO_WIDTH = 1280;
const PHOTO_HEIGHT = 851;
// The 24-pixel preview the app shows while the photo downloads
// (messaging/attachments.ts makes the same thing on a phone).
const PHOTO_PREVIEW =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAQABgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCgtta6kwlgtVZ2H3VcLzT7fQL2WbENg+D2U5H51ShOm6YAxvZJgvXYi8fUZzVx/HtraxhIIZSB/FHMEJ/Ja9WVRHnxgUfE082mxjT4SYLhD/pBBGRxwoPr60Viavr9heRyJDpnks/Jkad3Yn1ornlJt7nRGKSP/9k=";

const EMAIL = "demo-account@seixo.invalid";
const DAY_SECONDS = 24 * 60 * 60;
const MIN_PUBLISHED_PREKEYS = 20;
const PREKEY_BATCH = 50;
/** Short replies after the script, per person per day. */
const DAILY_REPLIES = 20;

// The script. English: it is read by App Review. The second message must trip
// the app's filter (messaging/contentFilter.ts) so it arrives hidden.
const SCRIPT_GREETING =
  "Hi! I'm Seixo's automatic demo account, here so the app can be tried on a single phone. I'll send a message with offensive language, a photo, and how to report and block.";
const SCRIPT_OFFENSIVE =
  "You're a fucking idiot. (A sample offensive message: Seixo's filter hides messages like this until you tap them.)";
const SCRIPT_HOW_TO =
  "Try the safety features: press and hold any of my messages to Report it or Delete it, or tap Block at the top to block this account. Reports reach the Seixo team, who act on them within 24 hours.";
const SHORT_REPLY =
  "This is an automatic demo account, so it can't really chat. Press and hold any message to report or delete it, or tap Block at the top.";

type Peers = Record<string, { scripted?: boolean; day?: string; count?: number }>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** bytea as PostgREST writes it ("\x0a1b..."). */
function toBytea(bytes: Uint8Array): string {
  return `\\x${hex(bytes)}`;
}

function fromBytea(value: string): Uint8Array {
  const digits = value.startsWith("\\x") ? value.slice(2) : value;
  const out = new Uint8Array(digits.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// ── Pinned assets ────────────────────────────────────────────────────────

let photo: Uint8Array | null = null;
let ready: Promise<void> | null = null;

async function fetchPinned(name: string, sha256: string): Promise<Uint8Array> {
  const response = await fetch(ASSETS + name);
  if (!response.ok) throw new Error(`asset ${name}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (digest !== sha256) throw new Error(`asset ${name}: checksum mismatch`);
  return bytes;
}

function loadAssets(): Promise<void> {
  ready ??= (async () => {
    const [wasm, image] = await Promise.all([
      fetchPinned("demo_account_bg.wasm", WASM_SHA256),
      fetchPinned("photo.jpg", PHOTO_SHA256),
    ]);
    initSync({ module: wasm });
    photo = image;
  })().catch((error) => {
    ready = null; // try again on the next call
    throw error;
  });
  return ready;
}

// ── Clients ──────────────────────────────────────────────────────────────

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

async function signInAsDemo(password: string): Promise<SupabaseClient> {
  const client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await client.auth.signInWithPassword({ email: EMAIL, password });
  if (error) throw new Error(`sign-in refused (${error.status ?? "?"})`);
  return client;
}

// ── Setup ────────────────────────────────────────────────────────────────

async function publishPrekeys(
  demo: SupabaseClient,
  userId: string,
  prekeys: { id: number; publicKey: string }[],
): Promise<void> {
  const { error } = await demo.from("one_time_prekeys").insert(
    prekeys.map((p) => ({ owner_id: userId, prekey_id: p.id, public_key: p.publicKey })),
  );
  if (error) throw new Error(`publishing prekeys failed (${error.code})`);
}

async function setup(): Promise<Response> {
  const { data: existing } = await admin.from("demo_account").select("user_id").maybeSingle();
  if (existing) return json({ userId: existing.user_id, created: false });

  const password = hex(crypto.getRandomValues(new Uint8Array(32)));
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: EMAIL,
    password,
    email_confirm: true,
  });
  if (createError || !created.user) return json({ error: "could not create the user" }, 500);
  const userId = created.user.id;

  const out = create(Date.now(), PREKEY_BATCH);
  const bundle = JSON.parse(out.json);
  const state = out.state;
  out.free();

  const demo = await signInAsDemo(password);
  const { error: identityError } = await demo.from("identities").insert({
    user_id: userId,
    identity_public_key: bundle.identityPublicKey,
    registration_id: bundle.registrationId,
  });
  if (identityError) return json({ error: `identity (${identityError.code})` }, 500);

  const { error: signedError } = await demo.from("signed_prekeys").insert({
    owner_id: userId,
    signed_prekey_id: bundle.signedPrekeyId,
    public_key: bundle.signedPrekeyPublic,
    signature: bundle.signedPrekeySignature,
    kyber_prekey_id: bundle.kyberPrekeyId,
    kyber_prekey_public_key: bundle.kyberPrekeyPublic,
    kyber_prekey_signature: bundle.kyberPrekeySignature,
  });
  if (signedError) return json({ error: `signed prekey (${signedError.code})` }, 500);
  await publishPrekeys(demo, userId, bundle.oneTimePrekeys);

  const { error: rowError } = await admin.from("demo_account").insert({
    user_id: userId,
    password,
    state: toBytea(state),
  });
  if (rowError) return json({ error: `state row (${rowError.code})` }, 500);
  return json({ userId, created: true });
}

// ── Answering ────────────────────────────────────────────────────────────

type Lease = { user_id: string; password: string; state: string; peers: Peers };

async function take(): Promise<Lease | null> {
  // Another instance may be mid-conversation; wait for it rather than give
  // up, so a burst of messages is answered in one pass or the next.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data } = await admin.rpc("demo_account_take", { seconds: 90 });
    if (Array.isArray(data) && data.length > 0) return data[0] as Lease;
    await sleep(1000);
  }
  return null;
}

/** Messages that change something rather than say something get no reply. */
function isControl(plaintext: string): boolean {
  if (!plaintext.startsWith("{")) return false;
  try {
    const parsed = JSON.parse(plaintext);
    if (parsed?.k !== "seixo.msg.v1") return false;
    return ["x", "z", "e", "s", "n"].some((field) => parsed[field] !== undefined);
  } catch {
    return false;
  }
}

class Conversation {
  constructor(
    private demo: SupabaseClient,
    private selfId: string,
    private peerId: string,
    private channelId: string,
    public state: Uint8Array,
  ) {}

  private seal(plaintext: string): string {
    const out = encrypt(this.state, this.selfId, this.peerId, plaintext, Date.now());
    this.state = out.state;
    const wire = out.json;
    out.free();
    return wire;
  }

  /** Returns the new message's id, or null if the server refused it. */
  async send(plaintext: string, serverTtlSeconds = DAY_SECONDS): Promise<string | null> {
    const ciphertext = this.seal(plaintext);
    const { data, error } = await this.demo
      .from("messages")
      .insert({
        channel_id: this.channelId,
        ciphertext,
        expires_at: new Date(Date.now() + serverTtlSeconds * 1000).toISOString(),
        silent: false,
      })
      .select("id")
      .single();
    if (error || !data) {
      console.error("[demo-account] send refused", error?.code);
      return null;
    }
    return data.id as string;
  }

  async sendPhoto(): Promise<boolean> {
    const sealed = seal_attachment(photo!);
    const key = sealed.key;
    const bytes = sealed.sealed;
    sealed.free();
    // The app's image payload (messaging/payload.ts), with the text older
    // builds show instead of the picture.
    const payload = JSON.stringify({
      k: "seixo.msg.v1",
      t: "Photo",
      l: DAY_SECONDS,
      i: { k: base64(key), w: PHOTO_WIDTH, h: PHOTO_HEIGHT, b: PHOTO_PREVIEW },
    });
    const id = await this.send(payload);
    if (!id) return false;
    // Named after its message, uploaded after it, as a phone does.
    const { error } = await this.demo.storage
      .from("attachments")
      .upload(id, bytes, { contentType: "application/octet-stream" });
    if (error) console.error("[demo-account] photo upload refused");
    return !error;
  }
}

async function answer(
  lease: Lease,
  demo: SupabaseClient,
  state: Uint8Array,
  item: { message_id: string; peer_id: string },
): Promise<Uint8Array> {
  const { data: message } = await admin
    .from("messages")
    .select("channel_id, ciphertext")
    .eq("id", item.message_id)
    .maybeSingle();
  if (!message) return state; // expired or deleted meanwhile

  let plaintext: string;
  try {
    const wire = JSON.parse(message.ciphertext);
    const out = decrypt(state, lease.user_id, item.peer_id, wire.t, wire.c);
    state = out.state;
    plaintext = JSON.parse(out.json).plaintext;
    out.free();
  } catch {
    console.error("[demo-account] could not open a message");
    return state;
  }
  if (isControl(plaintext)) return state;

  const conversation = new Conversation(demo, lease.user_id, item.peer_id, message.channel_id, state);
  const peer = (lease.peers[item.peer_id] ??= {});
  const today = new Date().toISOString().slice(0, 10);

  if (!peer.scripted) {
    peer.scripted = true;
    for (const step of [
      () => conversation.send(SCRIPT_GREETING),
      () => conversation.send(SCRIPT_OFFENSIVE),
      () => conversation.sendPhoto(),
      () => conversation.send(SCRIPT_HOW_TO),
    ]) {
      // A pause between them, so they arrive as separate messages in order
      // and read like someone typing rather than a burst.
      if (!(await step())) break;
      await sleep(1200);
    }
  } else {
    if (peer.day !== today) {
      peer.day = today;
      peer.count = 0;
    }
    if ((peer.count ?? 0) < DAILY_REPLIES) {
      peer.count = (peer.count ?? 0) + 1;
      await conversation.send(SHORT_REPLY);
    }
  }
  return conversation.state;
}

async function topUpPrekeys(demo: SupabaseClient, userId: string, state: Uint8Array): Promise<Uint8Array> {
  const { count } = await admin
    .from("one_time_prekeys")
    .select("*", { count: "exact", head: true })
    .eq("owner_id", userId);
  if ((count ?? 0) >= MIN_PUBLISHED_PREKEYS) return state;
  const out = add_one_time_prekeys(state, PREKEY_BATCH);
  const next = out.state;
  const prekeys = JSON.parse(out.json);
  out.free();
  await publishPrekeys(demo, userId, prekeys);
  return next;
}

async function drain(): Promise<Response> {
  let answered = 0;
  for (let pass = 0; pass < 5; pass++) {
    const lease = await take();
    if (!lease) return json({ answered, busy: true });

    let state = fromBytea(lease.state);
    try {
      const demo = await signInAsDemo(lease.password);
      for (;;) {
        const { data: items } = await admin
          .from("demo_account_inbox")
          .select("message_id, peer_id")
          .order("created_at", { ascending: true })
          .limit(10);
        if (!items || items.length === 0) break;
        for (const item of items) {
          state = await answer(lease, demo, state, item);
          // Saved after every message: the ratchet has moved, and losing
          // that would leave the next message from this person unreadable.
          await admin.rpc("demo_account_put", {
            new_state: toBytea(state),
            new_peers: lease.peers,
            release: false,
          });
          await admin.from("demo_account_inbox").delete().eq("message_id", item.message_id);
          answered++;
        }
      }
      state = await topUpPrekeys(demo, lease.user_id, state);
    } finally {
      await admin.rpc("demo_account_put", {
        new_state: toBytea(state),
        new_peers: lease.peers,
        release: true,
      });
    }

    // Something may have arrived after the last check, from a caller that
    // gave up waiting for the lease.
    const { count } = await admin
      .from("demo_account_inbox")
      .select("*", { count: "exact", head: true });
    if (!count) break;
  }
  return json({ answered });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const secret = req.headers.get("x-demo-secret");
  if (!secret) return json({ error: "not authorised" }, 401);
  const { data: allowed } = await admin.rpc("check_demo_account_secret", { secret });
  if (allowed !== true) return json({ error: "not authorised" }, 401);

  let action: string | undefined;
  try {
    action = (await req.json())?.action;
  } catch {
    // fall through
  }

  try {
    await loadAssets();
    if (action === "setup") return await setup();
    if (action === "drain") return await drain();
    return json({ error: "unknown action" }, 400);
  } catch (error) {
    console.error("[demo-account] failed:", error instanceof Error ? error.message : "unknown");
    return json({ error: "failed" }, 500);
  }
});
