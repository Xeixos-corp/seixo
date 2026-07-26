-- Another gap found while writing the app-side transport layer: the Rust
-- SignalDevice.generatePrekeyBundle(oneTimePrekeyId, signedPrekeyId,
-- kyberPrekeyId) takes caller-chosen integer ids, and those exact ids get
-- embedded in the X3DH/PQXDH message a peer sends — the receiving device
-- needs to look up its OWN locally-stored prekey by that same id to find
-- the matching private key. The previous migrations only stored the public
-- key material, never the id itself, so a peer reading these rows back had
-- no way to know which id to put in the bundle. Postgres's own `id uuid`
-- primary key on these tables is unrelated and not what's needed here.

alter table public.signed_prekeys
  add column if not exists signed_prekey_id integer not null default 0;

alter table public.one_time_prekeys
  add column if not exists prekey_id integer not null default 0;
