-- Mark every push notification as interceptable by the app, so the badge on
-- the app icon can count unread messages without the server knowing any of it.
--
-- iOS only hands a notification to a Notification Service Extension -- a small
-- piece of the app that runs on the phone when a push arrives, even with the
-- app closed -- when the payload says `mutable-content: 1`. Expo maps
-- `mutableContent: true` to exactly that. The extension adds one to a counter
-- kept on the device and sets the badge; the app replaces that count with the
-- real number of unread messages the next time it opens.
--
-- The alternative was for the server to count: send `badge: n` itself. That
-- needs the server to know when each person has read their messages, which
-- means the app reporting every time it is opened -- a usage record this
-- project has refused to keep (see 0016, which stores the date of last use and
-- deliberately not the time). Here the server learns nothing new: the flag is
-- the same on every notification.
--
-- Harmless for builds without the extension. iOS delivers a mutable-content
-- notification normally when there is nothing to intercept it.
--
-- Both function bodies are otherwise unchanged from 0015 and 0020.

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
             'sound', 'default',
             'mutableContent', true
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

create or replace function public.notify_group_member_added()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  payload jsonb;
begin
  if not exists (
    select 1 from public.channels c
     where c.id = new.channel_id and c.kind = 'group'
  ) then
    return new;
  end if;

  if new.member_id is not distinct from auth.uid() then
    return new;
  end if;

  select jsonb_build_object(
           'to', pt.token,
           'title', pt.notification_title,
           'body', coalesce(pt.notification_group_body, pt.notification_body),
           'sound', 'default',
           'mutableContent', true
         )
    into payload
    from public.push_tokens pt
   where pt.user_id = new.member_id
     and not exists (
       select 1 from public.blocked_peers bp
        where bp.owner_id = new.member_id
          and bp.blocked_user_id = auth.uid()
     );

  if payload is null then
    return new;
  end if;

  perform net.http_post(
    url := 'https://exp.host/--/api/v2/push/send',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_array(payload)
  );

  return new;
end;
$$;

revoke all on function public.notify_group_member_added() from public;
revoke all on function public.notify_group_member_added() from anon;
revoke all on function public.notify_group_member_added() from authenticated;
