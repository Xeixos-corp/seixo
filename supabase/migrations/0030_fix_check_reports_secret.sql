-- check_reports_secret (0029) always answered false, so every report alert
-- was refused with 401 and no email was sent.
--
-- Its parameter was named `secret`, and vault.decrypted_secrets has a column
-- of the same name -- the encrypted value. Inside the query the column won,
-- so the function compared the decrypted secret with its own ciphertext.
-- Found on the first test report, 2026-09-25. The parameter is now referred
-- to positionally, which no column can shadow.

create or replace function public.check_reports_secret(secret text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from vault.decrypted_secrets s
     where s.name = 'reports_notify_secret' and s.decrypted_secret = $1
  );
$$;

revoke all on function public.check_reports_secret(text) from public, anon, authenticated;
grant execute on function public.check_reports_secret(text) to service_role;
