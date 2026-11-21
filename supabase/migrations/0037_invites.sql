-- Single-use invites: a link that starts a conversation, instead of handing
-- out the permanent ID.
--
-- Why. People reach Seixo alone and leave because they have nobody to talk to
-- (2026-11-19/20: of 21 new accounts, one came back). Exchanging IDs is the
-- one way in, and it is the step people stumble on. An invite is a link a
-- person sends through any app they already use; the friend taps it and the
-- conversation opens. It works once and then expires, so a forwarded or
-- leaked link cannot become a way to reach someone for ever, and the ID
-- itself never leaves the phone.
--
-- How. The phone makes a random code (128 bits) and sends the server only its
-- SHA-256. The code travels in the link after the "#", which browsers never
-- send to any server, so neither the web page nor GitHub nor this database
-- ever sees it. Redeeming sends the code once, over the authenticated API; the
-- server hashes it, checks it, marks it used, and hands back only the
-- inviter's account id, which the redeemer needs to open an encrypted session
-- (exactly what an exchanged ID gives). The conversation itself is then made
-- with create_direct_channel, as for any ID.
--
-- What it tells the server that it did not know:
-- - that an account created an invite, and when. New, and the minimum: there
--   is no way to expire, limit or cancel invites without it.
-- - when an invite was used, but NOT by whom. used_at is kept without the
--   redeemer, so the row never says who accepted whom. (The channel that
--   follows does say who talks to whom, as every channel already does.)
-- Rows go away on their own: a used or expired invite is deleted a day later.
--
-- Limits: 7 days of life, at most 20 open invites per account, so the table
-- cannot be filled by a single account.

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null default auth.uid() references public.identities (user_id) on delete cascade,
  code_hash bytea not null unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  used_at timestamptz,
  constraint invites_hash_length check (octet_length(code_hash) = 32),
  constraint invites_lifetime check (expires_at <= created_at + interval '7 days')
);

create index invites_creator_idx on public.invites (creator_id);

alter table public.invites enable row level security;

-- Each account sees only its own invites, to list and cancel them. Nobody can
-- read anyone else's: the only way to use an invite is to hold its code.
create policy "invites are visible to their creator" on public.invites
  for select to authenticated
  using (creator_id = auth.uid());

create policy "invites can be cancelled by their creator" on public.invites
  for delete to authenticated
  using (creator_id = auth.uid());

revoke all on table public.invites from anon;
revoke insert, update on table public.invites from authenticated;
grant select, delete on table public.invites to authenticated;

-- Creating goes through a function so the limits are enforced here and not
-- trusted to the app.
create or replace function public.create_invite(code_hash bytea)
returns table (id uuid, expires_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null or not exists (select 1 from public.identities i where i.user_id = me) then
    raise exception 'not signed in';
  end if;
  if octet_length(code_hash) <> 32 then
    raise exception 'invalid invite';
  end if;
  if (select count(*) from public.invites v
       where v.creator_id = me and v.used_at is null and v.expires_at > now()) >= 20 then
    raise exception 'too many open invites';
  end if;

  return query
    insert into public.invites (creator_id, code_hash)
    values (me, create_invite.code_hash)
    returning invites.id, invites.expires_at;
end;
$$;

-- Using one. Returns the inviter's account id; the app then opens the
-- conversation with create_direct_channel and the usual key exchange.
-- Refused, with the same message, for an unknown, used or expired code, so a
-- guess learns nothing about which codes exist.
create or replace function public.redeem_invite(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
  invite_id uuid;
  inviter uuid;
begin
  if me is null or not exists (select 1 from public.identities i where i.user_id = me) then
    raise exception 'not signed in';
  end if;
  if code is null or length(code) < 16 or length(code) > 64 then
    raise exception 'invite not valid';
  end if;

  select v.id, v.creator_id into invite_id, inviter
    from public.invites v
   where v.code_hash = extensions.digest(convert_to(code, 'UTF8'), 'sha256')
     and v.used_at is null
     and v.expires_at > now()
   for update;

  if invite_id is null then
    raise exception 'invite not valid';
  end if;
  if inviter = me then
    raise exception 'own invite';
  end if;
  if exists (
    select 1 from public.blocked_peers b
     where (b.owner_id = me and b.blocked_user_id = inviter)
        or (b.owner_id = inviter and b.blocked_user_id = me)
  ) then
    raise exception 'blocked: cannot start a conversation with this user';
  end if;

  update public.invites set used_at = now() where invites.id = invite_id;
  return inviter;
end;
$$;

revoke all on function public.create_invite(bytea) from public, anon;
revoke all on function public.redeem_invite(text) from public, anon;
grant execute on function public.create_invite(bytea) to authenticated;
grant execute on function public.redeem_invite(text) to authenticated;

-- Used and expired invites are kept a day, so the creator's list can say
-- "used" or "expired", and then deleted.
select cron.schedule(
  'purge-invites',
  '17 * * * *',
  $$
    delete from public.invites
     where (used_at is not null and used_at < now() - interval '1 day')
        or expires_at < now() - interval '1 day';
  $$
);
