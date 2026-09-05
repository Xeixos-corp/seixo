-- Push notifications, without telling the server anything new.
--
-- The hard part is that `messages` has no sender column on purpose (sealed
-- sender, 0001_init.sql), so the server cannot look at a stored row and say
-- who sent it -- which is exactly what a naive "notify everyone else in the
-- channel" needs to know.
--
-- The way out: auth.uid() is available *inside the insert transaction*. The
-- server already had to know who was inserting in order to authorise it
-- against RLS; that fact is simply not persisted. Excluding the sender in an
-- AFTER INSERT trigger uses that same transient knowledge and stores nothing
-- extra. No sender_id column, no client telling the server who it is, no new
-- row anywhere.

create extension if not exists pg_net with schema extensions;

-- One device per user for now, matching the single-device assumption the
-- Signal session code already makes (REMOTE_DEVICE_ID = 1).
create table if not exists public.push_tokens (
  user_id uuid primary key,
  token text not null,
  -- The exact text to display, chosen by the recipient's own device rather
  -- than composed server-side.
  --
  -- The alternative was storing a language code and localising here, which
  -- would mean the server holds "this user reads Portuguese" for every user.
  -- Letting the device hand over the finished strings gets the same result
  -- while the server stays a dumb relay -- it never composes, and never has
  -- to know what any of it means. Neither field ever contains message
  -- content: nothing here is decryptable server-side, and the notification
  -- deliberately says only that something arrived.
  notification_title text not null,
  notification_body text not null,
  updated_at timestamptz not null default now(),
  constraint push_tokens_title_len check (char_length(notification_title) <= 100),
  constraint push_tokens_body_len check (char_length(notification_body) <= 200)
);

alter table public.push_tokens enable row level security;

-- Strictly self-access. Nobody reads anybody else's token through the API;
-- the only thing that ever reads another user's row is the SECURITY DEFINER
-- trigger below, which bypasses RLS by design.
create policy "push tokens are self-readable"
  on public.push_tokens for select
  using (user_id = auth.uid());

create policy "push tokens are self-insertable"
  on public.push_tokens for insert
  with check (user_id = auth.uid());

create policy "push tokens are self-updatable"
  on public.push_tokens for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "push tokens are self-deletable"
  on public.push_tokens for delete
  using (user_id = auth.uid());

create or replace function public.notify_channel_members()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  payload jsonb;
begin
  select jsonb_agg(
           jsonb_build_object(
             'to', pt.token,
             'title', pt.notification_title,
             'body', pt.notification_body,
             'sound', 'default'
           )
         )
    into payload
    from public.channel_members cm
    join public.push_tokens pt on pt.user_id = cm.member_id
   where cm.channel_id = new.channel_id
     -- The sender. `is distinct from` rather than `<>` so that a null
     -- auth.uid() (a service-role insert, say) still notifies everyone
     -- instead of silently notifying nobody.
     and cm.member_id is distinct from auth.uid();

  if payload is null then
    return new;
  end if;

  -- Asynchronous: pg_net queues the request and returns immediately, so a
  -- slow or unreachable push service can never delay or fail the insert.
  -- Sending a message must not depend on notifications working.
  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := payload
  );

  return new;
end;
$$;

-- Same footgun as 0008: a new function is granted EXECUTE to PUBLIC by
-- default, which would let anonymous callers fire it directly. Trigger
-- execution does not check EXECUTE, so revoking costs nothing here.
revoke all on function public.notify_channel_members() from public;
revoke all on function public.notify_channel_members() from anon;
revoke all on function public.notify_channel_members() from authenticated;

drop trigger if exists messages_notify_members on public.messages;
create trigger messages_notify_members
  after insert on public.messages
  for each row execute function public.notify_channel_members();
