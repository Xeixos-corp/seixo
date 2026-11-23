-- Calls ring only between people who have already talked.
--
-- Why. Anyone who has someone's ID can open a conversation with them, and
-- since 1.18.0 could ring their phone at once, on the lock screen, without a
-- word ever exchanged. Now a phone rings only for a conversation in which its
-- owner has written at least once, or which they started themselves;
-- otherwise the call is shown as a line in the conversation and does not
-- ring. The caller's own messages do not count: "hi" and a call straight
-- after would defeat it.
--
-- The phone keeps that fact itself (app/src/store/conversationsStore.ts,
-- `talked`), but it cannot be the only one to know it: when the app is
-- closed, a call arrives as a VoIP push, and iOS requires every such push to
-- be shown as a ringing call at once, before the app can look anything up. So
-- the push must not be sent in the first place. That decision is the
-- server's, in call_push_target, and it needs this one bit.
--
-- What it tells the server that it did not know: for each member of each
-- conversation, whether they have taken part in it (written in it, or
-- started it). The server already sees that a conversation has
-- messages, and the hosting logs record who sent them; this keeps it as a
-- flag. It never goes back to false, and it goes with the membership.
--
-- Existing memberships are set to true: everyone who could call whom before
-- this change still can, so nobody's contacts stop ringing.

alter table public.channel_members add column accepts_calls boolean not null default false;
update public.channel_members set accepts_calls = true;

-- Set by the member's own phone, for their own membership only.
create or replace function public.accept_calls(channel uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.channel_members
     set accepts_calls = true
   where channel_id = channel
     and member_id = auth.uid()
     and not accepts_calls;
$$;

revoke all on function public.accept_calls(uuid) from public, anon;
grant execute on function public.accept_calls(uuid) to authenticated;

create or replace function public.call_push_target(caller uuid, channel uuid)
returns table (token text, topic text, sandbox boolean)
language sql
security definer
set search_path = public
stable
as $$
  select vt.token, vt.topic, vt.sandbox
    from public.channel_members me
    join public.channel_members other
      on other.channel_id = me.channel_id
     and other.member_id <> me.member_id
    join public.voip_tokens vt on vt.user_id = other.member_id
   where me.channel_id = channel
     and me.member_id = caller
     -- The person being called has taken part in this conversation.
     and other.accepts_calls
     and (select count(*) from public.channel_members c where c.channel_id = channel) = 2
     and not exists (
       select 1 from public.blocked_peers b
        where (b.owner_id = other.member_id and b.blocked_user_id = caller)
           or (b.owner_id = caller and b.blocked_user_id = other.member_id)
     );
$$;

revoke all on function public.call_push_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.call_push_target(uuid, uuid) to service_role;
