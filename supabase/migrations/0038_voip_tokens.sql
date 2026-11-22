-- VoIP tokens: what lets a voice call ring a phone whose app is closed.
--
-- Why. Calls travel as ordinary encrypted messages (app/src/calls), so a
-- phone with Seixo open rings by itself. A closed app hears nothing until
-- something wakes it, and iOS has exactly one way to do that for a call: a
-- VoIP push (PushKit), sent to Apple with a token that only this kind of push
-- uses. It is separate from the ordinary push token in push_tokens: a
-- different token, for a different kind of push, which exists even when
-- notifications are turned off.
--
-- What it tells the server that it did not know:
-- - each account's VoIP token, the Apple app it belongs to (topic) and which
--   of Apple's servers to use (sandbox, for the Seixo Dev build). Needed to
--   send the push at all; the same kind of fact push_tokens already holds.
-- - when a call is placed, through the call-push Edge Function: that account
--   A asked for the other member of a conversation to be rung, at that
--   moment. Not stored by this migration -- nothing records it in a table --
--   but the hosting logs keep the request, as they keep every request. Not
--   whether the call was answered, nor its length, nor anything said: those
--   stay inside the encrypted messages. This is the one fact about calls the
--   server learns, and the policy says so.
--
-- call_push_target is what the Edge Function asks before sending: the other
-- member's token, only if the caller is in a two-person conversation with
-- them and neither has blocked the other. It is callable by the service role
-- only, so no client can read another account's token.

create table public.voip_tokens (
  user_id uuid primary key references auth.users (id) on delete cascade,
  token text not null check (token ~ '^[0-9a-f]{32,200}$'),
  topic text not null check (topic in ('com.xeixos.seixo.voip', 'com.xeixos.seixo.dev.voip')),
  sandbox boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.voip_tokens enable row level security;

create policy "own voip token is readable"
  on public.voip_tokens for select
  using (user_id = auth.uid());

create policy "own voip token can be written"
  on public.voip_tokens for insert
  with check (user_id = auth.uid());

create policy "own voip token can be updated"
  on public.voip_tokens for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "own voip token can be deleted"
  on public.voip_tokens for delete
  using (user_id = auth.uid());

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
     -- Calls are one to one: a conversation with exactly two members.
     and (select count(*) from public.channel_members c where c.channel_id = channel) = 2
     and not exists (
       select 1 from public.blocked_peers b
        where (b.owner_id = other.member_id and b.blocked_user_id = caller)
           or (b.owner_id = caller and b.blocked_user_id = other.member_id)
     );
$$;

revoke all on function public.call_push_target(uuid, uuid) from public, anon, authenticated;
grant execute on function public.call_push_target(uuid, uuid) to service_role;
grant select, insert, update, delete on public.voip_tokens to authenticated;
