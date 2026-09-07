-- Blocking someone stopped their messages from showing, but not their
-- notifications: the app hides the conversation and refuses to decrypt
-- anything from a blocked peer (app/src/messaging/ingest.ts), while the
-- notification trigger added in 0010 knew only about channel membership. The
-- blocked peer could still insert into the existing channel -- 0007 only
-- prevents *new* channels -- so the row landed, the trigger fired, and the
-- person who did the blocking got a notification for a message they would
-- then never see. Worse than no blocking at all, in a way: an alert with
-- nothing behind it.
--
-- The fix reuses what the trigger already has. auth.uid() is the sender, and
-- blocked_peers is right there; a member who has blocked the sender is simply
-- not included in the payload.
--
-- Deliberately NOT also rejecting the insert. Refusing it would tell the
-- blocked person they have been blocked, which is exactly the signal that
-- invites retaliation -- so, as in every other messenger, the send appears to
-- succeed and the message quietly goes nowhere. It costs a row that no one
-- will ever read, and the existing TTL purge removes it on schedule like any
-- other.
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
     and cm.member_id is distinct from auth.uid()
     -- Anyone who has blocked the sender.
     and not exists (
       select 1
         from public.blocked_peers bp
        where bp.owner_id = cm.member_id
          and bp.blocked_user_id = auth.uid()
     );

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

revoke all on function public.notify_channel_members() from public;
revoke all on function public.notify_channel_members() from anon;
revoke all on function public.notify_channel_members() from authenticated;
