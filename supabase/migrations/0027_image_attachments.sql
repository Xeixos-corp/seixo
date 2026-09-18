-- Storage for encrypted images, and the machinery that makes sure none of it
-- outlives the message it belongs to.
--
-- The design is in docs/plans-deferred.md. The short version: an image is
-- encrypted once on the phone with a random key and stored here as an opaque
-- object named after its message id; each member receives only the key,
-- inside their ordinary encrypted envelope. A ten-person group costs one
-- object and ten keys. Putting the image inside the message instead, as voice
-- does, breaks on groups: a group message is one row carrying a copy per
-- member, and realtime drops any row over 1024 KB.
--
-- This migration is the half that had to exist and be proven *before* the app
-- could send anything: storage, access rules, and deletion.

-- ── The bucket ─────────────────────────────────────────────────────────────
--
-- Private. Nothing here is ever served without passing the policies below.
-- 2 MB is generous for a 1600-pixel JPEG padded to a 64 KB boundary, and small
-- enough that the bucket is useless as general file hosting. Only opaque bytes
-- are accepted: the phone encrypts before uploading, so anything with a real
-- content type is by definition something that was not encrypted.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('attachments', 'attachments', false, 2097152, array['application/octet-stream'])
on conflict (id) do nothing;

-- ── Who may read and write ────────────────────────────────────────────────
--
-- An object is named exactly after the message it belongs to. Access is then
-- the same question the rest of the schema already asks: is the caller a
-- member of that message's channel? The subqueries run as the caller, so the
-- existing row-level security on messages and channel_members applies inside
-- them too.
--
-- Upload is additionally limited to two minutes after the message was
-- created. Without a sender column -- deliberately absent from one-to-one
-- messages -- the database cannot tell which member sent a message, so any
-- member could claim another's message id first. They could not inject
-- anything: the key travels inside the encrypted message and AES-GCM rejects
-- any other ciphertext, so the worst outcome is an image shown as unavailable.
-- The window makes even that a race against a sender who uploads in seconds.
--
-- No update or delete policy exists. Nobody alters an object once written,
-- and deleting is the purge's job alone.
drop policy if exists "attachments are readable by members of the message's channel" on storage.objects;
create policy "attachments are readable by members of the message's channel"
on storage.objects for select to authenticated
using (
  bucket_id = 'attachments'
  and exists (
    select 1
      from public.messages m
      join public.channel_members cm on cm.channel_id = m.channel_id
     where m.id::text = storage.objects.name
       and cm.member_id = auth.uid()
  )
);

drop policy if exists "attachments are uploadable by members just after the message" on storage.objects;
create policy "attachments are uploadable by members just after the message"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'attachments'
  and exists (
    select 1
      from public.messages m
      join public.channel_members cm on cm.channel_id = m.channel_id
     where m.id::text = storage.objects.name
       and cm.member_id = auth.uid()
       and m.created_at > now() - interval '2 minutes'
  )
);

-- ── Forgetting who uploaded ───────────────────────────────────────────────
--
-- Storage records the uploader in `owner` and `owner_id`. A one-to-one
-- message deliberately has no sender column, and an object that remembered
-- its uploader would reintroduce exactly that -- for the life of the object.
--
-- Cleared before the row is written, so it never exists at all; and again on
-- update, in case the storage service ever rewrites it. The upload request
-- still passes through the hosting layer's request log, which keeps the
-- account id for 24 hours (privacy policy): the same exposure every other
-- request already has, and no more.
--
-- What cannot be cleared: `last_accessed_at`, which the storage service
-- updates on every download. It is close to a read receipt -- it tells the
-- server roughly when the recipient fetched the image. It lives only as long
-- as the object (at most a day, see below) and is declared in the privacy
-- policy rather than pretended away.
create or replace function public.forget_attachment_uploader()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.bucket_id = 'attachments' then
    new.owner := null;
    new.owner_id := null;
  end if;
  return new;
end;
$$;

revoke all on function public.forget_attachment_uploader() from public;
revoke all on function public.forget_attachment_uploader() from anon;
revoke all on function public.forget_attachment_uploader() from authenticated;

drop trigger if exists attachments_forget_uploader on storage.objects;
create trigger attachments_forget_uploader
  before insert or update on storage.objects
  for each row execute function public.forget_attachment_uploader();

-- ── Deletion ──────────────────────────────────────────────────────────────
--
-- The first plan was a trigger on messages deleting the matching object. It
-- cannot work, and Supabase is right to stop it: storage.objects is guarded by
-- storage.protect_delete(), because deleting the row there leaves the bytes
-- behind in the object store -- encrypted files nobody knows exist. That is
-- precisely the outcome this feature must never produce.
--
-- So deletion goes through the Storage API, which removes both, from an Edge
-- Function (supabase/functions/purge-attachments) called every minute. It
-- deletes every object whose message no longer exists. Messages carrying an
-- image are capped at 24 hours on the server, like voice -- the server is a
-- waiting room, not an archive -- so an image lives at most a day and a minute,
-- and as little as its own timer allows.
--
-- There is no second kind of orphan to sweep for. The app inserts the message
-- first and uploads after, so an object always starts life with its message
-- beside it; a failed upload leaves a message with nothing attached, which the
-- recipient shows as unavailable, and nothing on the server. The 25-hour
-- backstop is for the case nobody has thought of.

-- The function authenticates the caller with a secret that is created here,
-- inside the database, and never leaves it: not in this repository, not in the
-- function's environment, not in anyone's terminal. The function asks the
-- database whether what it received is correct.
select vault.create_secret(
  encode(extensions.gen_random_bytes(32), 'hex'),
  'attachments_purge_secret',
  'Authorises the database to call the purge-attachments function.'
)
where not exists (select 1 from vault.secrets where name = 'attachments_purge_secret');

create or replace function public.claim_expired_attachments(secret text, max_count integer default 100)
returns setof text
language plpgsql
security definer
set search_path = ''
as $$
declare
  expected text;
begin
  select decrypted_secret into expected
    from vault.decrypted_secrets
   where name = 'attachments_purge_secret';

  if expected is null or secret is distinct from expected then
    raise exception 'not authorised' using errcode = '42501';
  end if;

  return query
    select o.name
      from storage.objects o
     where o.bucket_id = 'attachments'
       and o.created_at < now() - interval '1 minute'
       and (
         not exists (select 1 from public.messages m where m.id::text = o.name)
         or o.created_at < now() - interval '25 hours'
       )
     order by o.created_at
     limit greatest(1, least(max_count, 1000));
end;
$$;

revoke all on function public.claim_expired_attachments(text, integer) from public;
revoke all on function public.claim_expired_attachments(text, integer) from anon;
revoke all on function public.claim_expired_attachments(text, integer) from authenticated;
grant execute on function public.claim_expired_attachments(text, integer) to service_role;

-- Every minute, but only when there is something to delete: most minutes the
-- condition is false and no request is made at all.
select cron.unschedule('purge-expired-attachments')
where exists (select 1 from cron.job where jobname = 'purge-expired-attachments');

select cron.schedule(
  'purge-expired-attachments',
  '* * * * *',
  $$
    select net.http_post(
      url := 'https://zopexbtdbqboijysmpuy.supabase.co/functions/v1/purge-attachments',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-purge-secret', (
          select decrypted_secret from vault.decrypted_secrets
           where name = 'attachments_purge_secret'
        )
      ),
      body := '{}'::jsonb
    )
    where exists (
      select 1
        from storage.objects o
       where o.bucket_id = 'attachments'
         and o.created_at < now() - interval '1 minute'
         and (
           not exists (select 1 from public.messages m where m.id::text = o.name)
           or o.created_at < now() - interval '25 hours'
         )
    );
  $$
);
