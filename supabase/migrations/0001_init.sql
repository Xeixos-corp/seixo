-- Core schema. Metadata-minimization rules followed throughout this file:
--   * no phone number / email is required anywhere (auth.users rows are created via
--     Supabase anonymous sign-in on the client; see app/src/transport)
--   * "messages" has no sender_id column — sender identity lives only inside the
--     encrypted envelope (sealed sender), never as a plain column Postgres can read
--   * every row that represents a live conversation artifact carries expires_at and
--     is purged by pg_cron (see 0002_pg_cron_ttl.sql) — nothing is kept "forever" by default
--   * channel_id is an opaque random uuid, never derived from the pair of user ids
--
-- Tables are created first, policies afterwards, so policies can freely reference
-- any table in this schema regardless of declaration order.

create extension if not exists pgcrypto;

-- One row per registered identity. auth.users already gives us a random uuid with
-- no PII attached (anonymous auth) — this table only adds the Signal-style public
-- identity key, never the private key.
create table if not exists public.identities (
  user_id uuid primary key references auth.users (id) on delete cascade,
  identity_public_key text not null,
  display_name_ciphertext text, -- optional, encrypted client-side; never plaintext
  created_at timestamptz not null default now()
);

-- X3DH signed prekey (one active per user, rotated periodically by the client).
create table if not exists public.signed_prekeys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.identities (user_id) on delete cascade,
  public_key text not null,
  signature text not null,
  created_at timestamptz not null default now()
);

-- One-time prekeys: consumed (deleted) the moment another user claims one to start
-- a session, so they never linger as reusable material.
create table if not exists public.one_time_prekeys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.identities (user_id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now()
);

-- Opaque conversation identifier. Membership is the minimum mapping Postgres must
-- hold to route/authorize delivery — everything else about the conversation
-- (content, and who sent which message) is not visible to the server.
create table if not exists public.channels (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table if not exists public.channel_members (
  channel_id uuid not null references public.channels (id) on delete cascade,
  member_id uuid not null references public.identities (user_id) on delete cascade,
  primary key (channel_id, member_id)
);

-- Messages: ciphertext only. No sender_id column by design (sealed sender).
-- expires_at is mandatory — the client always sets a TTL (default disappearing
-- timer if the user didn't pick one explicitly).
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels (id) on delete cascade,
  ciphertext text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists messages_channel_id_created_at_idx
  on public.messages (channel_id, created_at);

create index if not exists messages_expires_at_idx
  on public.messages (expires_at);

-- Row Level Security -------------------------------------------------------

alter table public.identities enable row level security;
alter table public.signed_prekeys enable row level security;
alter table public.one_time_prekeys enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;

create policy "identities are self-readable and readable by channel peers"
  on public.identities for select
  using (
    user_id = auth.uid()
    or user_id in (
      select cm.member_id
      from public.channel_members cm
      where cm.channel_id in (
        select channel_id from public.channel_members where member_id = auth.uid()
      )
    )
  );

create policy "identities are self-writable"
  on public.identities for insert
  with check (user_id = auth.uid());

create policy "identities are self-updatable"
  on public.identities for update
  using (user_id = auth.uid());

create policy "signed prekeys are self-writable"
  on public.signed_prekeys for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy "signed prekeys are readable by anyone establishing a session"
  on public.signed_prekeys for select
  using (auth.uid() is not null);

create policy "one-time prekeys are self-writable"
  on public.one_time_prekeys for insert
  with check (owner_id = auth.uid());

create policy "one-time prekeys are claimable by anyone authenticated"
  on public.one_time_prekeys for select
  using (auth.uid() is not null);

create policy "one-time prekeys are deletable by anyone authenticated (claim = delete)"
  on public.one_time_prekeys for delete
  using (auth.uid() is not null);

create policy "channels are readable by members"
  on public.channels for select
  using (
    id in (select channel_id from public.channel_members where member_id = auth.uid())
  );

create policy "channels are creatable by any authenticated user"
  on public.channels for insert
  with check (auth.uid() is not null);

create policy "channel membership is readable by members of the same channel"
  on public.channel_members for select
  using (
    channel_id in (select channel_id from public.channel_members where member_id = auth.uid())
  );

create policy "channel membership is self-insertable"
  on public.channel_members for insert
  with check (member_id = auth.uid());

create policy "channel membership is self-deletable (leave conversation)"
  on public.channel_members for delete
  using (member_id = auth.uid());

create policy "messages are readable by channel members"
  on public.messages for select
  using (
    channel_id in (select channel_id from public.channel_members where member_id = auth.uid())
  );

create policy "messages are insertable by channel members"
  on public.messages for insert
  with check (
    channel_id in (select channel_id from public.channel_members where member_id = auth.uid())
  );

create policy "messages are deletable by channel members (manual delete / burn)"
  on public.messages for delete
  using (
    channel_id in (select channel_id from public.channel_members where member_id = auth.uid())
  );
