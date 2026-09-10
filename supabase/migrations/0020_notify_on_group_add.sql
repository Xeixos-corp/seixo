-- Being added to a group produced no notification, because notifications are
-- driven by new *messages* and joining a group is a row in another table.
-- Someone could be added and only find out the next time they happened to
-- open the app.
--
-- Same shape as 0010: the text is written by the recipient's own device, so
-- the server relays a string it never composes and never has to understand --
-- and does not learn what language anyone reads.
--
-- The trigger fires on channel_members and deliberately stays quiet in three
-- cases: channels that are not groups (create_direct_channel inserts two
-- members too, and "you were added to a group" would be wrong for an ordinary
-- conversation); the person doing the adding, including a group's creator
-- inserting themselves; and anyone who has blocked the person adding them,
-- consistent with 0012.
alter table public.push_tokens
  add column if not exists notification_group_body text;

update public.push_tokens
   set notification_group_body = notification_body
 where notification_group_body is null;

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
           'sound', 'default'
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

drop trigger if exists channel_members_notify_added on public.channel_members;
create trigger channel_members_notify_added
  after insert on public.channel_members
  for each row execute function public.notify_group_member_added();
