-- Hardening: stop unauthenticated callers from reaching the two SECURITY
-- DEFINER helpers over PostgREST (/rest/v1/rpc/...).
--
-- Why this was open: PostgreSQL grants EXECUTE on new functions to PUBLIC by
-- default. 0003 and 0004 both added `grant execute ... to authenticated`, but
-- neither revoked that default, so `anon` (no session at all) could call them.
-- 0004 additionally granted `is_channel_member` to `anon` explicitly.
--
-- Why it matters here specifically: neither function can corrupt data from an
-- unauthenticated call (channel_members.member_id is NOT NULL, so the insert
-- in create_direct_channel fails and rolls back with auth.uid() = NULL). What
-- they *do* leak is metadata, which is the one thing this project exists to
-- minimise (see docs/threat-model.md):
--
--   * create_direct_channel raises a distinguishable 'peer identity not found'
--     versus a NOT NULL violation, so an anonymous caller holding a user_id
--     can confirm whether that person is a Seixo user.
--   * is_channel_member answers "is user X in channel Y?" directly, to anyone,
--     with no session — precisely the channel-membership metadata the threat
--     model commits to keeping to authorised members.
--
-- Safe because the app signs in (anonymously) before issuing any query:
-- registerIdentity's doRegister() awaits signInAnonymouslyIfNeeded() first, so
-- every real client is `authenticated`, never `anon`. RLS policies that call
-- is_channel_member keep working for authenticated users; an anon read of
-- channel_members now fails closed instead of silently evaluating to false.

revoke execute on function public.create_direct_channel(uuid) from public;
revoke execute on function public.create_direct_channel(uuid) from anon;
grant execute on function public.create_direct_channel(uuid) to authenticated;

revoke execute on function public.is_channel_member(uuid, uuid) from public;
revoke execute on function public.is_channel_member(uuid, uuid) from anon;
grant execute on function public.is_channel_member(uuid, uuid) to authenticated;
