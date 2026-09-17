-- A conversation could be deleted for the crime of working as designed.
--
-- 0002 purges channels older than seven days that have no messages, to clear
-- away conversations somebody set up and never used. The flaw only shows once
-- the disappearing timer does its job: messages expire, and a channel that has
-- been in daily use for months becomes indistinguishable from one that was
-- never touched. Seven days old, no messages, deleted -- taking its members
-- with it, for everyone.
--
-- It happened: a group in real use disappeared from both phones, and the only
-- reason the busiest one-to-one conversation survived is that it never went a
-- whole day without a message. It would have gone the first time it did.
--
-- The fix is one bit. A trigger sets it when a channel's first message
-- arrives, and the purge only deletes channels that never got one.
--
-- A bit, deliberately, and not a timestamp. "When did these two last speak"
-- would be a fact about people that outlives the messages themselves -- the
-- thing this project refuses elsewhere, which is why 0016 keeps only the day
-- of last use and never the time. "This channel was used at least once" is
-- the question the purge needs answered, and nothing more.
alter table public.channels
  add column if not exists ever_used boolean not null default false;

-- Everything that exists today is treated as used, including channels whose
-- messages have already expired. There is no way to tell them apart now, and
-- the safe direction is obvious: keeping a dead channel costs two rows,
-- deleting a live conversation costs somebody their contact.
update public.channels set ever_used = true where ever_used = false;

create or replace function public.mark_channel_used()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.channels set ever_used = true
   where id = new.channel_id and not ever_used;
  return new;
end;
$$;

revoke all on function public.mark_channel_used() from public;
revoke all on function public.mark_channel_used() from anon;
revoke all on function public.mark_channel_used() from authenticated;

drop trigger if exists messages_mark_channel_used on public.messages;
create trigger messages_mark_channel_used
  after insert on public.messages
  for each row execute function public.mark_channel_used();

-- The purge now reads the bit rather than counting messages. Same intent as
-- 0002 -- clear away conversations that were started and never used -- without
-- mistaking an expired conversation for an abandoned one.
--
-- The second statement is new, and is the genuine litter: *direct* channels
-- left with fewer than two members. A one-to-one conversation needs two
-- people; one with a single member, or none, cannot deliver anything to
-- anybody and is already invisible to the one who remains -- fetchMyChannels
-- skips a channel with no peer. Four of them existed when this was written.
--
-- Groups are excluded on purpose. A group with one member is a normal state,
-- not litter: the owner created it and has not added anyone yet, and the app
-- has a notice for exactly that. Deleting it out from under them after a week
-- would be the same class of mistake this migration exists to fix.
select cron.unschedule('purge-empty-stale-channels')
where exists (select 1 from cron.job where jobname = 'purge-empty-stale-channels');

select cron.schedule(
  'purge-empty-stale-channels',
  '30 * * * *',
  $$
    delete from public.channels c
     where c.created_at < now() - interval '7 days'
       and not c.ever_used;

    delete from public.channels c
     where c.created_at < now() - interval '7 days'
       and c.kind = 'direct'
       and (select count(*) from public.channel_members m where m.channel_id = c.id) < 2;
  $$
);
