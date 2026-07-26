-- The Rust SignalDevice (packages/signal-native) uses libsignal-protocol's
-- PQXDH, which makes the Kyber prekey mandatory, not optional — discovered
-- after 0001_init.sql was written (which only had columns for classic X3DH:
-- an EC signed prekey + an EC one-time prekey). generatePrekeyBundle()
-- always produces exactly one signed EC prekey + one Kyber prekey together,
-- so the Kyber fields live on signed_prekeys rather than a separate table —
-- same lifecycle, published/rotated as one unit.

alter table public.signed_prekeys
  add column if not exists kyber_prekey_id integer not null default 0,
  add column if not exists kyber_prekey_public_key text not null default '',
  add column if not exists kyber_prekey_signature text not null default '';
