-- create_direct_channel created a new channel every single time it was
-- called, so two people could -- and did -- end up with dozens of separate
-- conversations with each other. The visible trigger was the QR scanner
-- firing its callback many times a second, but the scanner only exposed
-- this: typing the same user_id twice did it too.
--
-- Returning the existing channel makes the function idempotent, which is what
-- it should always have been. The client now checks locally as well
-- (app/src/identity/startConversation.ts), but that check depends on local
-- state that can be lost or wiped; this one cannot be.
--
-- Not just cosmetic. Each extra call also claimed one of the peer's one-time
-- prekeys, which are a finite pool, and re-established the Double Ratchet
-- session for that peer -- which can leave messages already in flight
-- permanently undecryptable.
create or replace function public.create_direct_channel(peer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_channel_id uuid;
  existing_channel_id uuid;
begin
  if peer_id = auth.uid() then
    raise exception 'cannot create a channel with yourself';
  end if;

  if not exists (select 1 from public.identities where user_id = peer_id) then
    raise exception 'peer identity not found';
  end if;

  if exists (
    select 1 from public.blocked_peers
    where (owner_id = auth.uid() and blocked_user_id = peer_id)
       or (owner_id = peer_id and blocked_user_id = auth.uid())
  ) then
    raise exception 'blocked: cannot start a conversation with this user';
  end if;

  -- Reuse rather than create. The blocked check stays above this on purpose:
  -- a blocked pair should be refused even if a channel already exists between
  -- them from before the block.
  select mine.channel_id
    into existing_channel_id
    from public.channel_members mine
    join public.channel_members theirs on theirs.channel_id = mine.channel_id
   where mine.member_id = auth.uid()
     and theirs.member_id = peer_id
   order by mine.channel_id
   limit 1;

  if existing_channel_id is not null then
    return existing_channel_id;
  end if;

  insert into public.channels default values returning id into new_channel_id;

  insert into public.channel_members (channel_id, member_id)
  values (new_channel_id, auth.uid()), (new_channel_id, peer_id);

  return new_channel_id;
end;
$$;

revoke all on function public.create_direct_channel(uuid) from public;
revoke all on function public.create_direct_channel(uuid) from anon;
grant execute on function public.create_direct_channel(uuid) to authenticated;
