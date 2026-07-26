-- App Store Review Guideline 1.2 (User-Generated Content) requires "the
-- ability to block abusive users from the service" for any app with
-- user-to-user communication. This adds that.
--
-- Unlike other tables in this schema, blocked_peers is deliberately NOT
-- subject to the TTL-purge philosophy (supabase/migrations/0002_pg_cron_ttl.sql)
-- — a block is a standing safety preference, not conversation metadata that
-- should expire. It persists until the user removes it (or deletes their
-- account, which cascades it away like everything else).
--
-- Only the owner can ever read their own block list (no policy grants
-- anyone else SELECT) — who you've blocked is not something the server
-- exposes to other users, consistent with this project's metadata
-- minimization stance. create_direct_channel below is SECURITY DEFINER, so
-- it can still check both directions without needing a public-read policy.

create table if not exists public.blocked_peers (
  owner_id uuid not null references public.identities (user_id) on delete cascade,
  blocked_user_id uuid not null references public.identities (user_id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, blocked_user_id)
);

alter table public.blocked_peers enable row level security;

create policy "blocked peers are self-manageable"
  on public.blocked_peers for all
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

-- Reject creating a new direct channel if either party has blocked the
-- other. Existing channels/messages between two people who later block each
-- other are NOT retroactively deleted here — that's a client-side decision
-- (hide the conversation locally, stop decrypting new messages from that
-- channel — see app/src/screens/ConversationListScreen.tsx /
-- ConversationScreen.tsx) rather than a server-side one, consistent with
-- messages already being TTL-purged regardless.
create or replace function public.create_direct_channel(peer_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_channel_id uuid;
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

  insert into public.channels default values returning id into new_channel_id;

  insert into public.channel_members (channel_id, member_id)
  values (new_channel_id, auth.uid()), (new_channel_id, peer_id);

  return new_channel_id;
end;
$$;

grant execute on function public.create_direct_channel(uuid) to authenticated;
