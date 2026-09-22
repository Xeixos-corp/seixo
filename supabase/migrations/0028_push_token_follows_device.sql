-- A push token belongs to the device, and it should follow whichever
-- identity that device is using now.
--
-- 0014 made tokens unique, and the app "claims" its token before saving it by
-- deleting any other row that holds it (notifications/pushTokens.ts). That
-- claim never worked across accounts: RLS lets a user delete only their own
-- rows, so the delete silently removed nothing, the insert then hit the
-- unique constraint (409), and the new identity was left with no token at
-- all. Found on 2026-09-22 when a reinstall followed by a new identity got no
-- notifications -- the old identity, still alive on the server, kept the
-- phone's token. Restoring a backup on the same phone would fail the same
-- way.
--
-- The fix moves the claim to the server, where it can see the other row: a
-- BEFORE INSERT/UPDATE trigger, SECURITY DEFINER, that removes any other
-- identity's row holding the same token just before this one is written.
-- No app change is needed; the existing upsert now succeeds.
--
-- What this allows, stated plainly: anyone who knows a device's Expo push
-- token can take it from the identity that holds it, so that identity stops
-- being notified and its alerts go to the new owner. The token is readable
-- only by its own identity (RLS on SELECT) and never leaves the phone
-- otherwise, so taking it requires already having that phone. The server
-- learns nothing new: it already stores the token.

create or replace function public.push_token_follows_device()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.push_tokens
   where token = new.token
     and user_id <> new.user_id;
  return new;
end;
$$;

revoke all on function public.push_token_follows_device() from public;

drop trigger if exists push_token_follows_device on public.push_tokens;
create trigger push_token_follows_device
  before insert or update of token on public.push_tokens
  for each row execute function public.push_token_follows_device();
