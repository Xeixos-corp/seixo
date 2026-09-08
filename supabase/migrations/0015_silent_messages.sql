-- Reactions travel as ordinary encrypted messages, because that is the only
-- delivery path there is. Without this they would each fire the notification
-- trigger from 0010, so reacting to five messages would send five "you have a
-- new message" alerts for things that are not messages.
--
-- This is a real, if small, addition to what the server holds: it now sees
-- that a given row is not a normal message. Worth stating plainly rather than
-- pretending otherwise. Two things make it acceptable. The column says only
-- "do not notify", not what the row contains -- the server still cannot tell
-- a reaction from any other control message, now or later. And the size of
-- the ciphertext already gave this away: a reaction is a handful of bytes
-- where a message is hundreds, so anyone reading the table could already
-- separate them. Padding ciphertext to fixed buckets would close both leaks
-- together, and is the right fix if that ever matters.
--
-- Default false, so every existing row and every ordinary message is
-- unaffected and still notifies.
alter table public.messages
  add column if not exists silent boolean not null default false;

create or replace function public.notify_channel_members()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  payload jsonb;
begin
  -- Nothing to announce: the sender asked for this row to arrive quietly.
  if new.silent then
    return new;
  end if;

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
     and cm.member_id is distinct from auth.uid()
     and not exists (
       select 1
         from public.blocked_peers bp
        where bp.owner_id = cm.member_id
          and bp.blocked_user_id = auth.uid()
     );

  if payload is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := payload
  );

  return new;
end;
$$;

revoke all on function public.notify_channel_members() from public;
revoke all on function public.notify_channel_members() from anon;
revoke all on function public.notify_channel_members() from authenticated;
