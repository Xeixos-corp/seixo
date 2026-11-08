-- The demo account speaks first; and the two tidy-ups left for after review.
--
-- Why. The app opens a conversation with the demo contact with "Hi!" drafted
-- in the box but never sends it: nothing leaves a phone until Send. The demo
-- account answered only to a message, so whoever did not press Send saw an
-- empty chat. Every new person who tried it on 2026-11-08 did exactly that,
-- as did the App Review device on 2026-11-06. Now the account greets as soon
-- as the conversation exists: the script (greeting, a message with offensive
-- language for the filter, a photo, how to report and block) arrives on its
-- own, once per person.
--
-- What it tells the server that it did not know: nothing. The channel and its
-- two members already exist; this only queues the channel id, and the queue
-- row is deleted once the greeting is sent.
--
-- Only conversations someone opened with the demo account get anything. It
-- cannot write to anyone else: it has no channel with them.

create table public.demo_account_greetings (
  channel_id uuid primary key references public.channels (id) on delete cascade,
  peer_id uuid not null,
  created_at timestamptz not null default now()
);

alter table public.demo_account_greetings enable row level security;
revoke all on table public.demo_account_greetings from anon, authenticated;

-- A one-to-one channel the demo account has just been added to. Both members
-- are inserted by the same statement (create_direct_channel), and an AFTER
-- ROW trigger runs once the statement is done, so the other member is
-- already there to read.
create or replace function public.greet_from_demo_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  demo uuid;
  peer uuid;
begin
  select user_id into demo from public.demo_account;
  if demo is null or new.member_id <> demo then
    return new;
  end if;
  if not exists (select 1 from public.channels where id = new.channel_id and kind = 'direct') then
    return new;
  end if;
  select member_id into peer
    from public.channel_members
   where channel_id = new.channel_id and member_id <> demo
   limit 1;
  if peer is null then
    return new;
  end if;

  insert into public.demo_account_greetings (channel_id, peer_id)
  values (new.channel_id, peer)
  on conflict do nothing;
  perform public.wake_demo_account();
  return new;
end;
$$;

revoke all on function public.greet_from_demo_account() from public, anon, authenticated;

create trigger channel_members_greet_from_demo_account
  after insert on public.channel_members
  for each row execute function public.greet_from_demo_account();

-- The scripted greeting takes about seven seconds; pg_net gave up waiting
-- after five and logged a timeout although the function finished. Now it
-- waits a minute, so a timeout in net._http_response means something real.
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
    body := '{"action":"drain"}'::jsonb,
    timeout_milliseconds := 60000
  );
$$;

revoke all on function public.wake_demo_account() from public, anon, authenticated;

-- The retry job now also covers a greeting whose wake-up was lost.
select cron.schedule(
  'demo-account-retry',
  '* * * * *',
  $$
    select public.wake_demo_account()
     where exists (select 1 from public.demo_account_inbox where created_at < now() - interval '20 seconds')
        or exists (select 1 from public.demo_account_greetings where created_at < now() - interval '20 seconds');
  $$
);

-- Migration 0028 left this trigger function executable through the API.
-- Harmless (Postgres refuses to call a trigger function directly), but every
-- other internal function here is closed, and the advisor flags this one.
revoke all on function public.push_token_follows_device() from public, anon, authenticated;
