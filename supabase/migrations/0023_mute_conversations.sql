-- Silencing a conversation: no notification for messages arriving in it.
--
-- This has to be the server's decision, and it is worth writing down why,
-- because the obvious place for it is the phone. The push payload carries no
-- channel id -- deliberately, so that Expo and Apple never learn which
-- conversation a device belongs to (see app/src/notifications/
-- notificationRouting.ts). A notification arriving at the phone therefore
-- cannot be matched to a conversation, and iOS gives a Notification Service
-- Extension no way to drop an alert anyway; it may only rewrite its contents.
-- Silencing on the device is not possible. Not sending is.
--
-- What the server learns: that a given member has muted a given channel. It
-- already knows that member belongs to that channel -- that row is what this
-- column hangs off -- so no new link between people is created. What is new
-- is one preference, and only for conversations somebody chose to mute. That
-- is the same trade accepted in 0015 for the `silent` column, and a smaller
-- one: 0015 told the server something about messages, this tells it something
-- about a setting.
--
-- Default false, so every existing membership keeps notifying.
alter table public.channel_members
  add column if not exists muted boolean not null default false;

-- Changing it goes through a function rather than an UPDATE policy, so that
-- the only thing a member can ever write on their own row is this flag. An
-- RLS policy permitting UPDATE would have to permit it on the whole row.
create or replace function public.set_channel_muted(channel_id uuid, muted boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.channel_members cm
     set muted = set_channel_muted.muted
   where cm.channel_id = set_channel_muted.channel_id
     and cm.member_id = auth.uid();

  if not found then
    raise exception 'not a member of this channel';
  end if;
end;
$$;

revoke all on function public.set_channel_muted(uuid, boolean) from public;
revoke all on function public.set_channel_muted(uuid, boolean) from anon;
grant execute on function public.set_channel_muted(uuid, boolean) to authenticated;

-- The trigger body is otherwise unchanged from 0022: the only difference is
-- that a muted membership is not collected into the list of destinations, so
-- nothing is sent to that device for this channel at all. Messages themselves
-- are untouched and arrive exactly as before -- this silences the alert, not
-- the conversation.
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
