-- Without this, deleting an account leaves its push token behind: the
-- delete-account Edge Function removes the auth.users row, which cascades
-- through identities to every other table (blocked_peers, channel_members,
-- one_time_prekeys, signed_prekeys) -- but push_tokens was created without a
-- foreign key, so it was the one thing that would have survived. A stale
-- token is exactly the kind of leftover an account deletion is supposed to
-- remove.
alter table public.push_tokens
  add constraint push_tokens_user_id_fkey
  foreign key (user_id) references public.identities (user_id) on delete cascade;
