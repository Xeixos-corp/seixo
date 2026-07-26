# Supabase backend

Two ways to run this, same `migrations/` either way — schema and RLS are identical.

## Development: Supabase Cloud (current setup)

Docker isn't available on the primary dev machine yet, so development targets a
Supabase Cloud project for now. This still keeps message content and (per the
schema) sender identity out of plain columns, but note Supabase Inc.'s
infrastructure does see connection IP/timing regardless — see
[`docs/threat-model.md`](../docs/threat-model.md).

1. Create a free project at supabase.com.
2. Install the Supabase CLI, then from this `supabase/` directory:
   ```
   supabase link --project-ref <your-project-ref>
   supabase db push
   ```
3. In the Supabase dashboard, enable **Anonymous sign-ins** under
   Authentication > Providers (this is how identities are created without a
   phone number or email — see `0001_init.sql`).
4. Enable the `pg_cron` extension under Database > Extensions (the migration
   turns it on at the SQL level, but Cloud projects also need the dashboard
   toggle the first time).
5. Copy the project URL and anon key into `app/.env` (see `app/.env.example`).

## Production: self-hosted

Switch to `docker-compose.yml` in this directory before public launch — see the
caveat comment at the top of that file about verifying it against Supabase's
current official self-hosting reference first, since service versions move
fast and this file is not something we can test locally without Docker yet.

```
cp .env.example .env   # fill in real generated secrets
docker compose up -d
supabase link --project-ref local   # or point the CLI at http://localhost:8000
supabase db push
```

## Migrations

- `0001_init.sql` — tables (`identities`, `signed_prekeys`, `one_time_prekeys`,
  `channels`, `channel_members`, `messages`) and RLS policies.
- `0002_pg_cron_ttl.sql` — scheduled purge jobs (expired messages every minute,
  stale unclaimed prekeys hourly, abandoned empty channels every 30 minutes).
- `0003_direct_channels.sql` — `identities.registration_id`, the
  `create_direct_channel()` RPC (lets a user add a peer to a new 1:1 channel
  despite RLS only allowing self-inserts into `channel_members`), and
  realtime publication for `messages`/`channel_members`.
- `0004_fix_channel_members_rls_recursion.sql` — fixes an infinite-recursion
  bug (Postgres `42P17`) in the original `channel_members` SELECT policy,
  found while testing 0003 against the live API with two real anonymous
  users. Root cause and fix are explained in the file.
- `0005_kyber_prekeys.sql` — adds the Kyber/PQXDH prekey columns to
  `signed_prekeys` that `0001_init.sql` didn't have (PQXDH's Kyber prekey
  turned out to be mandatory in `libsignal-protocol`, not optional — see
  `packages/signal-native/README.md`).
- `0006_prekey_ids.sql` — adds `signed_prekey_id` / `prekey_id` columns:
  the Rust-side prekey ids (chosen by the caller of `generatePrekeyBundle`)
  need to be published too, not just the public key material, so a peer can
  embed the correct id in the X3DH/PQXDH message it sends.

All of 0003–0006 were applied against the live dev project
(`zopexbtdbqboijysmpuy`) via the Supabase MCP connector and verified with two
real anonymous test users exercising the actual REST API before being
committed here — see `app/src/transport/` for the client code that depends
on this schema.
