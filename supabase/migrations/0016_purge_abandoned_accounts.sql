-- Nothing ever removed an account. Messages, unclaimed prekeys and empty
-- channels are all purged on schedule (0002), but an identity created once and
-- never used again stayed forever, and with it the identity key, the signed
-- prekey, the auth row, the push token, the block list and every channel
-- membership. Not a storage problem -- a few hundred bytes each -- but a
-- metadata one: a subpoena years from now would reach every identity that ever
-- existed and who shared a channel with whom, including people who deleted the
-- app long before.
--
-- Deleting them requires knowing when an account was last used, which is
-- itself a new and uncomfortable thing to record. Two decisions keep that as
-- small as possible.
--
-- First, a date and not a timestamp. Knowing someone used the app on the 8th
-- is enough to decide whether the account is abandoned; knowing they used it
-- at 17:19 is a usage pattern nobody asked us to keep.
--
-- Second, the same reduction is applied to push_tokens.updated_at, which had
-- been recording exactly that -- to the second -- as an unintended side effect
-- of a column added for housekeeping. It was never a decision, and it is
-- being unmade here.

alter table public.identities
  add column if not exists last_active_on date;

-- Existing rows: assume they were last active when they were created. That is
-- the most pessimistic reading available and errs towards keeping accounts,
-- never towards deleting one early.
update public.identities
   set last_active_on = created_at::date
 where last_active_on is null;

alter table public.push_tokens
  alter column updated_at type date using updated_at::date;

alter table public.push_tokens
  alter column updated_at set default current_date;

-- Six months of no sign of life. Deleting from auth.users rather than from
-- identities: everything else cascades from there, so this removes the
-- account whole rather than leaving an orphaned auth row behind.
--
-- The cost, stated plainly: someone who returns after six months finds a new
-- identity, and anyone who had them as a contact is left talking to a ghost.
-- That is why the window is generous rather than tidy.
select cron.schedule(
  'purge-abandoned-accounts',
  '17 4 * * *',
  $$
    delete from auth.users u
     where exists (
       select 1
         from public.identities i
        where i.user_id = u.id
          and coalesce(i.last_active_on, i.created_at::date) < current_date - interval '6 months'
     );
  $$
);
