# Seixo

An end-to-end encrypted messenger. iPhone only so far; Android is planned but
has never shipped. Real Signal Protocol via a Rust crate, Supabase for
transport, anonymous accounts with no phone number, email or password.

| Where | What |
| --- | --- |
| `app/` | the Expo app — see `app/AGENTS.md` for its own rules |
| `packages/signal-native/` | the Rust crate (Signal Protocol, recovery backups) and its uniffi bindings |
| `app/modules/` | local Expo native modules: audio routing, the shared badge |
| `supabase/` | numbered migrations and Edge Functions, applied to the live project |
| `docs/` | the sources of the privacy policy, terms and FAQ |

## Things that will actually break

**The Android `.so` libraries are stale.** They predate the recovery-backup
Rust API (`generate_recovery_phrase`, `encrypt_backup`, `restore_identity`,
`derive_backup_credentials`) and the image API (`seal_attachment`,
`open_attachment`), all of which the Kotlin bridge already calls. An Android
build today compiles, links, installs, and then fails at runtime on the first
call. Rebuild them with cargo-ndk before any Android build; iOS is unaffected
because it compiles the Rust from source in the EAS pre-install hook.

**The iOS project cannot be generated on Windows**, which is where this is
developed. `expo prebuild` will not run, so nothing native is verified locally.
A native change is only proven by an EAS build — and the built `.ipa` is worth
opening and reading (Info.plist, entitlements, bundled files) rather than
assuming.

**The published documents are part of the product.** `docs/privacy-policy.md`,
`docs/terms-of-use.md` and `docs/faq.md` are the sources; the published pages
live in the separate public repo `Xeixos-corp/Seixo-Legal` (GitHub Pages) in
three languages. Changing what the app does with anyone's data, or where a
setting lives, can make those pages false — they have said "Settings →
Blocked" while that screen was somewhere else. Check them when behaviour moves.

## Conventions

Comments say **why**, not what. The reasoning behind a decision — especially
one that looks odd — is the thing worth keeping; the code already says what it
does.

**Three locales, always in parity**: `app/src/i18n/locales/{pt,en,es}.json`.
European Portuguese, not Brazilian. A key added to one is added to all three.

**Migrations are append-only.** They are numbered, they carry their reasoning
in a comment at the top, and they have already been applied to the live
database. Never edit an applied one; add the next number.

**The server is not trusted with anything it does not need.** Before adding a
column, a field or a payload, ask what it tells the server that it could not
already work out. If the answer is "something", say so in the comment and
justify it — that is the standard the existing migrations hold themselves to.

## Working with the owner

Production writes (migrations, Edge Function deploys, submissions, deleting
accounts), builds, and anything that publishes publicly are confirmed with him
first. He writes in European Portuguese and reads replies in it. He never hands
over Apple credentials — anything needing them, he runs himself.
