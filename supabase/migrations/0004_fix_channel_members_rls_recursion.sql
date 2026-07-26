-- Bug found while testing 0003 against the real API (two real anonymous
-- users, Alice creating a channel with Bob): "channel membership is
-- readable by members of the same channel" (0001_init.sql) checked
-- membership via a subquery on channel_members itself. Evaluating that
-- subquery re-triggers the same RLS policy on channel_members, which
-- re-triggers it again, forever (Postgres error 42P17, "infinite recursion
-- detected in policy"). This broke every table whose policies subquery
-- channel_members (identities, channels, messages), not just
-- channel_members itself, since they all hit the same recursive policy
-- underneath.
--
-- Standard fix: a SECURITY DEFINER helper function. Because it's owned by
-- the table owner, its internal query bypasses RLS entirely instead of
-- re-invoking the policy, breaking the recursion. Verified against the live
-- project with two real anonymous users after this fix: channel creation,
-- cross-member reads of channels/channel_members/identities all work.

create or replace function public.is_channel_member(p_channel_id uuid, p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.channel_members
    where channel_id = p_channel_id and member_id = p_user_id
  );
$$;

grant execute on function public.is_channel_member(uuid, uuid) to authenticated, anon;

drop policy if exists "channel membership is readable by members of the same channel" on public.channel_members;
create policy "channel membership is readable by members of the same channel"
  on public.channel_members for select
  using (public.is_channel_member(channel_id, auth.uid()));
