-- An automatic demo account, so App Review can test the app on one phone.
--
-- Why it exists. Seixo has no directory and no strangers: a new account starts
-- with nobody to talk to. App Review tests with a single device, so every
-- reviewer so far created an account, found an empty screen and rejected the
-- app under guideline 1.2 for features it could not reach -- the filter,
-- reporting, blocking. The server logs of 2026-09-30 show exactly that: two
-- accounts from the US, one of which created two empty groups looking for
-- something to do, and not a single message sent.
--
-- What it is. An ordinary Seixo account -- identity, prekeys, Signal sessions
-- -- whose phone is the `demo-account` Edge Function. Anyone given its id can
-- write to it; it answers with a fixed script (a greeting, a message with
-- offensive language for the filter, a photo, how to report and block) and
-- after that with one short line. Its id is published only in the review
-- notes; nothing in the app lists or suggests it.
--
-- What it tells the server that it did not know. Messages sent *to this
-- account* are decrypted by the server, because the server is this account's
-- phone: end-to-end encryption protects a conversation from everyone except
-- the two ends, and here one end is ours. Nothing else changes -- no other
-- account's messages pass through this code, and the function never logs what
-- it reads. Stated in the privacy policy and the FAQ.
--
-- The account's own private keys and session state live in demo_account,
-- readable by the service role only. They protect nothing but conversations
-- with this account, whose content the server reads anyway by design.

-- ── The account ───────────────────────────────────────────────────────────

create table public.demo_account (
  -- One row, ever.
  singleton boolean primary key default true check (singleton),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  -- Signs the function in as this account, so everything it does goes
  -- through the same policies and triggers as a phone's requests: auth.uid()
  -- is the sender, push notifications go to the other person only, a block
  -- applies as it would to anyone. Random, made by the function, never shown.
  password text not null,
  -- libsignal state, as packages/demo-account serializes it.
  state bytea not null,
  -- Per-person bookkeeping: whether the script was sent, how many replies
  -- today. Keyed by the other person's id.
  peers jsonb not null default '{}'::jsonb,
  -- One function instance at a time may touch the state: two decrypting at
  -- once would each advance the ratchet from the same starting point and one
  -- result would be lost. A lease rather than a lock, because a function that
  -- dies mid-way must not hold it forever.
  lease_until timestamptz,
  created_at timestamptz not null default now()
);

alter table public.demo_account enable row level security;
-- No policies: nothing but the service role can read or write it.
revoke all on table public.demo_account from anon, authenticated;

create or replace function public.is_demo_account(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.demo_account where user_id = uid);
$$;

revoke all on function public.is_demo_account(uuid) from public, anon, authenticated;

-- ── Messages waiting for an answer ────────────────────────────────────────

-- Only the id: the function reads the row itself. Deleted with the message
-- when it expires, and by the function once answered.
create table public.demo_account_inbox (
  message_id uuid primary key references public.messages (id) on delete cascade,
  peer_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.demo_account_inbox enable row level security;
revoke all on table public.demo_account_inbox from anon, authenticated;

select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'demo_account_secret',
  'Shared between pg_net and the demo-account Edge Function'
)
where not exists (select 1 from vault.secrets where name = 'demo_account_secret');

create or replace function public.check_demo_account_secret(secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'demo_account_secret' and s.decrypted_secret = $1
  );
$$;

revoke all on function public.check_demo_account_secret(text) from public, anon, authenticated;
grant execute on function public.check_demo_account_secret(text) to service_role;

create or replace function public.wake_demo_account()
returns void
language sql
security definer
set search_path = public, extensions
as $$
  select net.http_post(
    url := 'https://zopexbtdbqboijysmpuy.supabase.co/functions/v1/demo-account',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-demo-secret', (
        select decrypted_secret from vault.decrypted_secrets
         where name = 'demo_account_secret'
      )
    ),
    body := '{"action":"drain"}'::jsonb
  );
$$;

revoke all on function public.wake_demo_account() from public, anon, authenticated;

-- A message in a one-to-one conversation with the demo account, sent by the
-- other person (auth.uid() is the sender; the account's own replies are not
-- queued). Group messages are left alone: the script is for one-to-one.
create or replace function public.queue_for_demo_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  demo uuid;
begin
  select user_id into demo from public.demo_account;
  if demo is null or auth.uid() is null or auth.uid() = demo then
    return new;
  end if;
  if not exists (
    select 1
      from public.channel_members cm
      join public.channels c on c.id = cm.channel_id
     where cm.channel_id = new.channel_id
       and cm.member_id = demo
       and c.kind = 'direct'
  ) then
    return new;
  end if;

  insert into public.demo_account_inbox (message_id, peer_id)
  values (new.id, auth.uid())
  on conflict do nothing;
  perform public.wake_demo_account();
  return new;
end;
$$;

revoke all on function public.queue_for_demo_account() from public, anon, authenticated;

create trigger messages_queue_for_demo_account
  after insert on public.messages
  for each row execute function public.queue_for_demo_account();

-- A wake-up that was lost (the function busy, a cold start that failed) is
-- retried a minute later rather than leaving a reviewer without an answer.
select cron.schedule(
  'demo-account-retry',
  '* * * * *',
  $$
    select public.wake_demo_account()
     where exists (
       select 1 from public.demo_account_inbox
        where created_at < now() - interval '20 seconds'
     );
  $$
);

-- ── The lease ─────────────────────────────────────────────────────────────

-- Hands the state to one caller, or nothing if another holds it.
create or replace function public.demo_account_take(seconds integer)
returns table (user_id uuid, password text, state bytea, peers jsonb)
language sql
security definer
set search_path = public
as $$
  update public.demo_account d
     set lease_until = now() + make_interval(secs => seconds)
   where d.lease_until is null or d.lease_until < now()
  returning d.user_id, d.password, d.state, d.peers;
$$;

-- Saves the state. Each save renews the lease, so a long pass is not
-- overtaken half-way; `release` ends it.
create or replace function public.demo_account_put(new_state bytea, new_peers jsonb, release boolean)
returns void
language sql
security definer
set search_path = public
as $$
  update public.demo_account
     set state = new_state,
         peers = new_peers,
         lease_until = case when release then null else now() + interval '90 seconds' end;
$$;

revoke all on function public.demo_account_take(integer) from public, anon, authenticated;
revoke all on function public.demo_account_put(bytea, jsonb, boolean) from public, anon, authenticated;
grant execute on function public.demo_account_take(integer) to service_role;
grant execute on function public.demo_account_put(bytea, jsonb, boolean) to service_role;

-- ── Exemptions ────────────────────────────────────────────────────────────

-- Reviewers are asked to report and block it; that is the point. Three
-- reviewers must not be able to suspend the account the next one needs.
create or replace function public.never_restrict_demo_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_demo_account(new.user_id) then
    return null;
  end if;
  return new;
end;
$$;

revoke all on function public.never_restrict_demo_account() from public, anon, authenticated;

create trigger account_restrictions_spare_demo_account
  before insert or update on public.account_restrictions
  for each row execute function public.never_restrict_demo_account();

-- Expelling it would also tear down every conversation it is in, so the
-- moderation page refuses rather than relying on the restriction trigger
-- above. Otherwise unchanged from migration 0029.
create or replace function public.moderate_report(report uuid, action text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target uuid;
  reported_message uuid;
  reporters integer;
begin
  select reported_user_id, message_id into target, reported_message
    from public.reports where id = report;
  if target is null then
    return 'not_found';
  end if;

  if action = 'ban' then
    if public.is_demo_account(target) then
      return 'demo_account';
    end if;

    insert into public.account_restrictions (user_id, state)
    values (target, 'banned')
    on conflict (user_id) do update set state = 'banned', created_at = now();

    delete from public.messages m
     using public.channels c
     where m.channel_id = c.id
       and c.kind = 'direct'
       and c.id in (select channel_id from public.channel_members where member_id = target);

    delete from public.messages m
     where m.channel_id in (select channel_id from public.channel_members where member_id = target)
       -- Only group envelopes name their sender. The CASE keeps one malformed
       -- row from aborting the whole expulsion: SQL does not promise to test
       -- an AND left to right, so the validity check has to guard the cast
       -- itself.
       and (case when pg_input_is_valid(m.ciphertext, 'jsonb') then m.ciphertext::jsonb end)
           @> jsonb_build_object('k', 'seixo.group.v1', 'f', target::text);

    if reported_message is not null then
      delete from public.messages where id = reported_message;
    end if;

    delete from public.channel_members where member_id = target;
    delete from public.push_tokens where user_id = target;

    update public.reports set status = 'actioned'
     where reported_user_id = target and status = 'open';
    return 'banned';

  elsif action = 'dismiss' then
    update public.reports set status = 'dismissed' where id = report;
    select count(distinct reporter_id) into reporters
      from public.reports
     where reported_user_id = target and status <> 'dismissed';
    if reporters < 3 then
      delete from public.account_restrictions where user_id = target and state = 'suspended';
    end if;
    return 'dismissed';

  elsif action = 'lift' then
    update public.reports set status = 'dismissed'
     where reported_user_id = target and status = 'open';
    delete from public.account_restrictions where user_id = target and state = 'suspended';
    return 'lifted';
  end if;

  return 'unknown_action';
end;
$$;

revoke all on function public.moderate_report(uuid, text) from public, anon, authenticated;
grant execute on function public.moderate_report(uuid, text) to service_role;

-- Long quiet spells between reviews are normal; the six-month purge of
-- abandoned accounts (migration 0016) passes over this one. Same job name,
-- so this replaces that schedule.
select cron.schedule(
  'purge-abandoned-accounts',
  '17 4 * * *',
  $$
    delete from auth.users u
     where exists (
       select 1
         from public.identities i
        where i.user_id = u.id
          and coalesce(i.last_active_on, i.created_at::date) < current_date - interval '6 months'
     )
       and not exists (select 1 from public.demo_account d where d.user_id = u.id);
  $$
);
