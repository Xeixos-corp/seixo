-- A reported photo or voice message now travels with its report.
--
-- Until now a report of a photo or a recording reached the developer as the
-- word "[photo]" and nothing else, which left no way to judge it: expel on
-- faith, or dismiss without looking. The person reporting now chooses to send
-- the photo or recording they received, exactly as they choose to send the
-- text of a reported message (0029). This is what WhatsApp does.
--
-- What the server gains: a readable copy of that one photo or recording, for
-- as long as its report exists (90 days), in a private bucket nobody can read
-- through the API -- only the `moderate` function, with a report's one-time
-- token, can make a short-lived link to it. Stated in the privacy policy.
--
-- Deletion follows the report. Storage objects cannot be deleted from SQL
-- (storage.protect_delete, see 0027), so a daily job asks the purge-attachments
-- Edge Function to remove evidence whose report no longer exists, using the
-- same vault secret as the attachment purge.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'report-evidence',
  'report-evidence',
  false,
  5242880,
  array['image/jpeg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a']
)
on conflict (id) do nothing;

-- What the evidence is, so the decision page knows how to show it.
alter table public.reports
  add column evidence_kind text check (evidence_kind is null or evidence_kind in ('photo', 'voice'));

-- The reporter may attach one file, named after their own report, within ten
-- minutes of making it, and never replace it. A definer function because the
-- reporter cannot read the reports table.
create or replace function public.can_attach_report_evidence(object_name text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
      select 1 from public.reports r
       where r.id::text = object_name
         and r.reporter_id = auth.uid()
         and r.evidence_kind is not null
         and r.created_at > now() - interval '10 minutes'
    )
    and not exists (
      select 1 from storage.objects o
       where o.bucket_id = 'report-evidence' and o.name = object_name
    );
$$;

revoke all on function public.can_attach_report_evidence(text) from public, anon;
grant execute on function public.can_attach_report_evidence(text) to authenticated;

-- Upload only. No select, update or delete policy: nobody reads evidence
-- through the API.
create policy "report evidence is uploadable by its reporter"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'report-evidence'
    and public.can_attach_report_evidence(name)
  );

-- Evidence whose report is gone -- purged after 90 days, or deleted with an
-- account. Same secret, same pattern as claim_expired_attachments.
create or replace function public.claim_orphan_report_evidence(secret text, max_count integer default 100)
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
     where o.bucket_id = 'report-evidence'
       and o.created_at < now() - interval '10 minutes'
       and not exists (select 1 from public.reports r where r.id::text = o.name)
     order by o.created_at
     limit greatest(1, least(max_count, 1000));
end;
$$;

revoke all on function public.claim_orphan_report_evidence(text, integer) from public, anon, authenticated;
grant execute on function public.claim_orphan_report_evidence(text, integer) to service_role;

select cron.schedule(
  'purge-orphan-report-evidence',
  '37 3 * * *',
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
      body := '{"bucket":"report-evidence"}'::jsonb
    )
    where exists (
      select 1 from storage.objects o
       where o.bucket_id = 'report-evidence'
         and o.created_at < now() - interval '10 minutes'
         and not exists (select 1 from public.reports r where r.id::text = o.name)
    )
  $$
);
