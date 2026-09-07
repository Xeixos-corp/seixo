-- push_tokens is keyed by user_id, which allowed the same device token to be
-- registered against several identities at once -- and it had: one phone here
-- was registered under two user_ids, because creating a new identity on a
-- device leaves the old row behind (a token is a property of the *device*,
-- and the device did not change).
--
-- The consequence is a notification for a conversation the app cannot show:
-- the phone is told about a message addressed to an identity it no longer
-- uses, so the alert arrives and nothing is behind it. Exactly the symptom
-- blocking produced, from a different cause.
--
-- Deleting the stale rows first, keeping the most recently updated row per
-- token -- that is by definition the identity the device is actually using.
delete from public.push_tokens pt
 where exists (
   select 1 from public.push_tokens newer
    where newer.token = pt.token
      and newer.updated_at > pt.updated_at
 );

alter table public.push_tokens
  add constraint push_tokens_token_unique unique (token);
