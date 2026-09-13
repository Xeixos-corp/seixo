-- Which sound the notification plays, chosen by each person for their own
-- device.
--
-- The sound files live inside the app, not here. A push carries only a file
-- name, and iOS looks that name up in the installed app -- so the server
-- never holds, sends or plays any audio, and adding a sound means shipping a
-- new version of the app rather than changing anything on this side.
--
-- It belongs on push_tokens because that row is already exactly this: the
-- things the server must know in order to compose a notification for one
-- device, all of them written by the device itself. The title and body are
-- there for the same reason -- so the server never learns which language
-- someone reads (0010). A sound name is the same kind of fact and no more
-- revealing than the two that were already here.
--
-- Null means the ordinary notification sound, which is what every existing
-- row and every older build of the app will keep getting. The constraint is
-- not security -- the row is only writable by its owner -- but it keeps a
-- malformed name from reaching Apple, where the result would be a silent
-- notification nobody could explain.
alter table public.push_tokens
  add column if not exists notification_sound text;

alter table public.push_tokens
  drop constraint if exists push_tokens_sound_name;

alter table public.push_tokens
  add constraint push_tokens_sound_name
  check (notification_sound is null or notification_sound ~ '^[a-z0-9_-]{1,30}\.wav$');

-- Both functions are otherwise unchanged from 0023 and 0022. coalesce keeps
-- 'default' for anyone who has not chosen, so nothing changes for them.
create or replace function public.notify_channel_members()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  payload jsonb;
begin
  if new.silent then
    return new;
  end if;

  select jsonb_agg(
           jsonb_build_object(
             'to', pt.token,
             'title', pt.notification_title,
             'body', pt.notification_body,
             'sound', coalesce(pt.notification_sound, 'default'),
             'mutableContent', true
           )
         )
    into payload
    from public.channel_members cm
    join public.push_tokens pt on pt.user_id = cm.member_id
   where cm.channel_id = new.channel_id
     and cm.member_id is distinct from auth.uid()
     and not cm.muted
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
           'sound', coalesce(pt.notification_sound, 'default'),
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
