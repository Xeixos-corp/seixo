-- Someone who was added as a contact found out only when the first message
-- arrived. Starting a conversation creates the channel and nothing else, and
-- 0020 kept its notification to groups on purpose: "you were added to a
-- group" would be wrong for an ordinary conversation. So the conversation sat
-- in the other person's list unannounced (reported 2026-11-10).
--
-- It now gets its own text, written by the recipient's device in its own
-- language, exactly like the other two (0010, 0020). Generic on purpose: it
-- does not say who, for the same reason a message notification says nothing
-- of what.
--
-- What this tells the server: nothing new. It already records who created
-- the channel and who is in it, and the third string reveals no more about
-- the reader's language than the two already stored.
--
-- No fallback to another text. A phone on an app version that predates this
-- column leaves it null and simply gets no notification here, as before,
-- rather than a group text that would be false or a message text when there
-- is no message.
--
-- The app version that sends this column needs it to exist, or its token
-- registration fails: apply this before installing that build anywhere.
alter table public.push_tokens
  add column if not exists notification_direct_body text;

create or replace function public.notify_group_member_added()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  channel_kind text;
  payload jsonb;
begin
  select c.kind into channel_kind
    from public.channels c
   where c.id = new.channel_id;

  if channel_kind is null then
    return new;
  end if;

  -- The person doing the adding: a group's creator inserting themselves, or
  -- the one starting a direct conversation.
  if new.member_id is not distinct from auth.uid() then
    return new;
  end if;

  select jsonb_build_object(
           'to', pt.token,
           'title', pt.notification_title,
           'body', case when channel_kind = 'group'
                        then coalesce(pt.notification_group_body, pt.notification_body)
                        else pt.notification_direct_body
                   end,
           'sound', coalesce(pt.notification_sound, 'default'),
           'mutableContent', true
         )
    into payload
    from public.push_tokens pt
   where pt.user_id = new.member_id
     and (channel_kind = 'group' or pt.notification_direct_body is not null)
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
