-- The owner could leave a group but not end it. Leaving removed only their
-- own membership, so the group carried on without them -- and with no owner,
-- nobody could ever add or remove anyone again. A group in that state cannot
-- be repaired, only abandoned.
--
-- Deleting the channel cascades to channel_members and messages, so the group
-- and everything said in it disappear from the server in one operation.
--
-- What it cannot do, and what the app must not imply: reach into anyone's
-- phone. Messages already delivered are decrypted and stored on each member's
-- device, and stay there until their own timer expires them. This ends the
-- group; it does not unsay what was said. The confirmation dialog says so.
create or replace function public.delete_group_channel(channel_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  channel_owner uuid;
begin
  select c.owner_id into channel_owner
    from public.channels c
   where c.id = channel_id and c.kind = 'group';

  if channel_owner is null then
    raise exception 'not a group, or it no longer exists';
  end if;
  if channel_owner is distinct from auth.uid() then
    raise exception 'only the group owner can delete the group';
  end if;

  delete from public.channels c where c.id = delete_group_channel.channel_id;
end;
$$;

revoke all on function public.delete_group_channel(uuid) from public;
revoke all on function public.delete_group_channel(uuid) from anon;
grant execute on function public.delete_group_channel(uuid) to authenticated;
