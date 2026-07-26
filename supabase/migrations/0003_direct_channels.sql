-- Adds what Milestone 2 (app <-> Supabase wiring) needs on top of 0001/0002:
--   * registration_id: the Rust SignalDevice generates this per identity
--     (returned by generatePrekeyBundle); peers need it to reconstruct a
--     valid PreKeyBundleData, but nothing stored it until now.
--   * create_direct_channel(): a controlled way for Alice to add Bob to a
--     new 1:1 channel. The existing "channel membership is self-insertable"
--     policy (0001_init.sql) intentionally only lets a user insert their own
--     membership row (prevents forcing yourself into someone else's
--     channel) — which also means Alice can't directly insert a row for
--     Bob. This security-definer function is the narrow, validated
--     exception: it creates exactly one channel and inserts exactly the
--     caller + one named peer, nothing else.
--   * realtime publication for messages/channel_members: without this,
--     Supabase Realtime never emits postgres_changes events for these
--     tables, so the app can't observe new messages or new memberships.

alter table public.identities
  add column if not exists registration_id integer not null default 0;

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

  insert into public.channels default values returning id into new_channel_id;

  insert into public.channel_members (channel_id, member_id)
  values (new_channel_id, auth.uid()), (new_channel_id, peer_id);

  return new_channel_id;
end;
$$;

grant execute on function public.create_direct_channel(uuid) to authenticated;

alter publication supabase_realtime add table public.messages;
alter publication supabase_realtime add table public.channel_members;
