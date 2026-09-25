-- Reports, suspension and expulsion: what App Review asked for under
-- Guideline 1.2 (2026-09-25), for an app where people talk without a real
-- identity.
--
-- The server still cannot read a single message. A report works the only way
-- it can in an end-to-end encrypted app: the person who received a message
-- decides to show it to us. The text they report is stored here -- the first
-- place message content ever reaches the server readable -- and it is there
-- because a participant chose to put it there, the same model WhatsApp and
-- Messenger use. It is deleted 90 days after the report, whatever happened.
--
-- What each report tells the server that it did not know: that the reporter
-- found this content objectionable, who they say sent it, and (for a direct
-- conversation) therefore who sent which message -- a link the database
-- otherwise never keeps. Stated in the privacy policy.
--
-- Nobody is expelled automatically. A report emails the developer (Edge
-- Function report-notify), who decides; a single report must never be able
-- to silence someone, or reporting becomes the weapon. The one automatic
-- step is a *suspension*: three different people reporting the same account
-- stop it from sending until the developer looks. Suspension is lifted by
-- dismissing the reports; expulsion is permanent for that account.

-- ── Restrictions ──────────────────────────────────────────────────────────

create table public.account_restrictions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state text not null check (state in ('suspended', 'banned')),
  created_at timestamptz not null default now()
);

alter table public.account_restrictions enable row level security;

-- Readable by the restricted account itself, so its app can say why sending
-- fails instead of failing silently. Nobody else can see who is restricted.
create policy "own restriction is readable"
  on public.account_restrictions for select
  using (user_id = auth.uid());

create or replace function public.is_restricted(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.account_restrictions where user_id = uid);
$$;

revoke all on function public.is_restricted(uuid) from public;

-- A restricted account cannot send. Checked in a trigger rather than in the
-- insert policy so the refusal carries a recognisable message the app can
-- turn into an explanation.
create or replace function public.refuse_restricted_sender()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_restricted(auth.uid()) then
    raise exception 'account_restricted' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_restricted_sender() from public;

create trigger messages_refuse_restricted_sender
  before insert on public.messages
  for each row execute function public.refuse_restricted_sender();

-- Nor start conversations or add people to groups (every path into
-- channel_members goes through an RPC that inserts here); and nobody can pull
-- an expelled account back into a conversation.
create or replace function public.refuse_restricted_membership()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and public.is_restricted(auth.uid()) then
    raise exception 'account_restricted' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.account_restrictions
     where user_id = new.member_id and state = 'banned'
  ) then
    raise exception 'account_restricted' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.refuse_restricted_membership() from public;

create trigger channel_members_refuse_restricted
  before insert on public.channel_members
  for each row execute function public.refuse_restricted_membership();

-- ── Reports ───────────────────────────────────────────────────────────────

create table public.reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  reporter_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  reported_user_id uuid not null references auth.users (id) on delete cascade,
  channel_id uuid references public.channels (id) on delete set null,
  -- No foreign key: the message may expire or be deleted before anyone looks.
  message_id uuid,
  -- What the reporter chose to show: the message's text, or a placeholder
  -- such as "[photo]". Null for a report about a person rather than a message.
  content text check (content is null or char_length(content) <= 4000),
  status text not null default 'open' check (status in ('open', 'actioned', 'dismissed')),
  -- SHA-256 of the one-time token in the developer's email link. The token
  -- itself is never stored.
  action_token_hash text
);

create index reports_reported_user_idx on public.reports (reported_user_id);

alter table public.reports enable row level security;

-- Insert only: a report is sent, never read back by anyone in the app. The
-- reporter and the reported account must both be in the conversation it came
-- from, so nobody can report a stranger they have never talked to.
create policy "reports are insertable by participants"
  on public.reports for insert
  with check (
    reporter_id = auth.uid()
    and reported_user_id <> auth.uid()
    and channel_id is not null
    and public.is_channel_member(channel_id, auth.uid())
    and public.is_channel_member(channel_id, reported_user_id)
    and status = 'open'
    and action_token_hash is null
  );

-- Twenty reports a day per account. Enough for any real situation; stops one
-- account from flooding the developer's inbox.
create or replace function public.limit_reports()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (select count(*) from public.reports
       where reporter_id = new.reporter_id
         and created_at > now() - interval '1 day') >= 20 then
    raise exception 'report_limit' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.limit_reports() from public;

create trigger reports_limit
  before insert on public.reports
  for each row execute function public.limit_reports();

-- ── Notifying the developer ──────────────────────────────────────────────

select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'reports_notify_secret',
  'Shared between pg_net and the report-notify / moderate Edge Functions'
)
where not exists (select 1 from vault.secrets where name = 'reports_notify_secret');

create or replace function public.after_report()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  reporters integer;
begin
  -- Three different people: suspend until the developer decides.
  select count(distinct reporter_id) into reporters
    from public.reports
   where reported_user_id = new.reported_user_id
     and status <> 'dismissed';
  if reporters >= 3 then
    insert into public.account_restrictions (user_id, state)
    values (new.reported_user_id, 'suspended')
    on conflict (user_id) do nothing;
  end if;

  perform net.http_post(
    url := 'https://zopexbtdbqboijysmpuy.supabase.co/functions/v1/report-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-report-secret', (
        select decrypted_secret from vault.decrypted_secrets
         where name = 'reports_notify_secret'
      )
    ),
    body := jsonb_build_object('report_id', new.id)
  );
  return new;
end;
$$;

revoke all on function public.after_report() from public;

create trigger reports_after_insert
  after insert on public.reports
  for each row execute function public.after_report();

-- Called by the Edge Functions with the service role, which is the only way
-- the secret is checked: it never leaves the database.
create or replace function public.check_reports_secret(secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets
     where name = 'reports_notify_secret' and decrypted_secret = secret
  );
$$;

revoke all on function public.check_reports_secret(text) from public, anon, authenticated;
grant execute on function public.check_reports_secret(text) to service_role;

-- ── Acting on a report ────────────────────────────────────────────────────

-- 'ban': expel the account. It can no longer send or be added anywhere; it
-- leaves every conversation; what it sent that is still on the server is
-- deleted -- its group messages (which name their sender), every message in
-- its direct conversations (which end with it), and the reported message
-- itself. Photos follow within a minute (purge-attachments removes files
-- whose message is gone). Its push token goes too. Copies already on other
-- people's phones cannot be reached by anyone; the person who reported can
-- delete theirs.
--
-- 'dismiss': this report was not justified. If that leaves fewer than three
-- people reporting a suspended account, the suspension lifts.
--
-- 'lift': dismiss every open report against the account and lift a
-- suspension.
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

-- ── Retention ─────────────────────────────────────────────────────────────

-- Reported content is kept 90 days after the report and then deleted,
-- whatever its status. Restrictions stay for as long as the account exists.
select cron.schedule(
  'purge-old-reports',
  '17 3 * * *',
  $$ delete from public.reports where created_at < now() - interval '90 days' $$
);
