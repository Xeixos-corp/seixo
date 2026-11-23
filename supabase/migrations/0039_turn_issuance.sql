-- A monthly count of TURN credentials handed out, so calls can never run up
-- a Cloudflare bill.
--
-- Why. Voice calls always go through Cloudflare's TURN relay, so neither side
-- learns the other's IP address (app/src/calls). Cloudflare gives 1,000 GB a
-- month free, then charges per GB. The call-turn Edge Function hands out a
-- short-lived credential for each side of each call; counting them per month
-- and refusing past a ceiling means the worst case is calls failing until the
-- month turns over, never an unexpected invoice.
--
-- What it tells the server that it did not know: how many call legs were set
-- up in a month, in total. Not by whom, not between whom, not when within the
-- month. One row per month.
--
-- take_turn_credential increments and returns whether the ceiling still
-- allows one more. Callable by the service role only.

create table public.turn_issuance (
  month date primary key,
  issued integer not null default 0
);

alter table public.turn_issuance enable row level security;
-- No policies: no client reads or writes this table.

create or replace function public.take_turn_credential(ceiling integer)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  this_month date := date_trunc('month', now())::date;
  count_now integer;
begin
  insert into public.turn_issuance (month, issued) values (this_month, 1)
  on conflict (month) do update set issued = turn_issuance.issued + 1
  returning issued into count_now;
  return count_now <= ceiling;
end;
$$;

revoke all on function public.take_turn_credential(integer) from public, anon, authenticated;
grant execute on function public.take_turn_credential(integer) to service_role;
