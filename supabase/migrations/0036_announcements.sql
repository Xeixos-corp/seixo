-- Announcements: a short public notice shown as a card at the top of the
-- conversation list, so a new tool (or how to use an old one) can be told to
-- everyone without a new version of the app.
--
-- Why a table and not a message. The demo account could post a message, but
-- only to people who opened a conversation with it, and 0033 promises it never
-- writes to anyone else. An official contact for everyone would mean a channel
-- with every account. A notice nobody has to receive is simpler and says less.
--
-- What it tells the server: nothing. Every phone reads the same rows, and it
-- reads them with the public anon key only, never with the account's session
-- (app/src/transport/announcements.ts), so even the hosting log of the request
-- holds an IP and no account. Whether someone saw, dismissed or opened a
-- notice is kept on the phone and never sent. There are no statistics, on
-- purpose.
--
-- Who writes. Nobody from the app: there is no insert, update or delete
-- policy, so only the owner can add a notice (dashboard or service role).
-- Every notice carries its text in the three languages of the app, so a phone
-- never shows one in a language it was not written for.

create table public.announcements (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  -- Shown from, and until. A notice with no end stays until replaced.
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  -- Only phones on this app version or later see it, so "you can now send
  -- your location" is not shown to someone whose app cannot. Plain "1.16.0".
  min_app_version text,
  title_pt text not null,
  title_en text not null,
  title_es text not null,
  body_pt text not null,
  body_en text not null,
  body_es text not null,
  -- Optional button. Both the label and the link per language: a video can
  -- have a version in each one.
  action_label_pt text,
  action_label_en text,
  action_label_es text,
  action_url_pt text,
  action_url_en text,
  action_url_es text,
  -- Links are limited to our own published pages, so a notice can never send
  -- people somewhere else, even by a typing mistake.
  constraint announcements_https_only check (
    coalesce(action_url_pt, '') ~ '^(https://xeixos-corp\.github\.io/Seixo-Legal/.*)?$'
    and coalesce(action_url_en, '') ~ '^(https://xeixos-corp\.github\.io/Seixo-Legal/.*)?$'
    and coalesce(action_url_es, '') ~ '^(https://xeixos-corp\.github\.io/Seixo-Legal/.*)?$'
  ),
  constraint announcements_window check (ends_at is null or ends_at > starts_at),
  constraint announcements_action_complete check (
    (action_url_pt is null) = (action_label_pt is null)
    and (action_url_en is null) = (action_label_en is null)
    and (action_url_es is null) = (action_label_es is null)
  )
);

alter table public.announcements enable row level security;

-- Readable by anyone, signed in or not: it is public text by design.
create policy "announcements are public" on public.announcements
  for select to anon, authenticated
  using (starts_at <= now() and (ends_at is null or ends_at > now()));

revoke insert, update, delete on table public.announcements from anon, authenticated;
grant select on table public.announcements to anon, authenticated;
