-- Time-to-live purge jobs. This is the mechanism that makes "temporary metadata"
-- actually temporary instead of aspirational: nothing here relies on the client
-- coming back to clean up after itself.
--
-- On Supabase Cloud, pg_cron must also be toggled on under
-- Database > Extensions in the dashboard the first time (this migration enables
-- it at the SQL level, which is sufficient for both Cloud and self-hosted).

create extension if not exists pg_cron with schema extensions;

-- Expired messages: purge every minute. A message that nobody has fetched by its
-- expiry is gone from the server regardless of whether any client ever opened it.
select
  cron.schedule(
    'purge-expired-messages',
    '* * * * *',
    $$ delete from public.messages where expires_at < now(); $$
  )
where not exists (
  select 1 from cron.job where jobname = 'purge-expired-messages'
);

-- One-time prekeys are meant to be deleted synchronously at claim time (see the
-- "one-time prekeys are deletable by anyone authenticated" policy), but this is a
-- safety net for prekeys that were generated and never claimed.
select
  cron.schedule(
    'purge-stale-unclaimed-prekeys',
    '0 * * * *',
    $$ delete from public.one_time_prekeys where created_at < now() - interval '30 days'; $$
  )
where not exists (
  select 1 from cron.job where jobname = 'purge-stale-unclaimed-prekeys'
);

-- Channels that never got a single message (abandoned conversation setup) and
-- have had no membership change recently — avoid Postgres accumulating channel
-- rows/membership metadata for conversations that were started but never used.
select
  cron.schedule(
    'purge-empty-stale-channels',
    '30 * * * *',
    $$
    delete from public.channels c
    where c.created_at < now() - interval '7 days'
      and not exists (select 1 from public.messages m where m.channel_id = c.id);
    $$
  )
where not exists (
  select 1 from cron.job where jobname = 'purge-empty-stale-channels'
);
