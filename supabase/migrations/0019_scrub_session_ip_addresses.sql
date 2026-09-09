-- Supabase's auth layer records the client IP address and user agent in
-- auth.sessions and keeps them for the life of the session. On this instance
-- that was 13 sessions and 4 distinct addresses going back to 2026-07-25 --
-- a longer, more identifying trail than anything this project's own schema
-- holds, and it arrived with the authentication service rather than by any
-- decision made here.
--
-- Deleting the sessions is not an option. Accounts are anonymous, so a device
-- that loses its session does not get logged out and back in -- it creates a
-- *new identity*, losing its user id, its contacts and every conversation.
-- The rows must stay.
--
-- Blanking the two columns keeps the session working and removes the trail.
-- Both are nullable, and neither is used for authentication: the JWT and the
-- refresh token carry everything that matters. They exist for the account
-- activity screens of apps that show "last seen from", which this app does
-- not have and does not want. Verified on a real device afterwards: sending
-- and receiving continued to work, and no identity was recreated.
--
-- Every minute, because the auth layer rewrites the IP whenever a token is
-- refreshed. The window in which an address exists is therefore about a
-- minute rather than forever. It cannot be zero without patching a service
-- this project does not control, and that limit is stated in the threat
-- model rather than glossed over.
update auth.sessions set ip = null, user_agent = null
 where ip is not null or user_agent is not null;

select cron.schedule(
  'scrub-session-ips',
  '* * * * *',
  $$
    update auth.sessions set ip = null, user_agent = null
     where ip is not null or user_agent is not null;

    -- Empty today, and kept that way. Audit entries carry IP addresses too.
    delete from auth.audit_log_entries where created_at < now() - interval '1 hour';
  $$
);
