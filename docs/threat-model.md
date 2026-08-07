# Threat model (initial draft — Milestone 0)

This is a living document. It exists so that every later decision ("can we
skip this?", "is this good enough to launch?") gets checked against something
written down instead of vibes. Treat any claim here as invalid once the
underlying implementation (linked file) changes without this doc being updated.

## What we're protecting against

- **A passive network observer** (ISP, Wi-Fi operator, on-path attacker)
  should not learn message content, and — when Tor is enabled — should have a
  much harder time correlating "device X talked to server Y at time Z."
- **The backend operator** (us, or Supabase Inc. if Cloud is used during dev)
  should never see plaintext message content or the raw sender-recipient
  mapping of an individual message (sealed sender, see `supabase/migrations/0001_init.sql`).
- **A device compromise after the fact** should not retroactively expose past
  conversations forever — this is why messages carry `expires_at` and are
  purged server-side by `pg_cron` regardless of whether the recipient ever
  opened the app (`supabase/migrations/0002_pg_cron_ttl.sql`).

## What we are explicitly NOT protecting against (yet, or ever)

- **A compromised endpoint device** (malware, physical access with the device
  unlocked, coerced unlock). No messaging app can defend against this; screen
  lock + OS-level encryption is the user's responsibility.
- **Global passive adversaries correlating traffic timing across the entire
  network** (traffic analysis at nation-state scale). Tor raises the cost of
  this; it does not make it impossible, especially for the party running both
  ends of a conversation over long periods.
- **Zero server-visible metadata.** This is not achievable with any
  centralized backend, self-hosted or not. What we commit to is *minimizing
  and time-limiting* what the server holds, not eliminating it. Concretely,
  the server (whoever operates the Postgres instance) still learns:
  - Which opaque `channel_id`s exist and which `user_id`s belong to them
    (`channel_members` table) — this is unavoidable; the server has to know
    who is authorized to read a channel to enforce RLS and route delivery.
  - Connection IP and request timing, unless the client is using the Tor
    toggle for that session.
  - Approximate message size and frequency (ciphertext length, insert rate),
    even though content and sender-within-a-message are hidden.

## Known platform-specific gaps

- **Tor on iOS is best-effort, not guaranteed.** Apple's review process and
  background-execution restrictions make an always-on embedded Tor daemon
  much less reliable on iOS than on Android. If App Store review rejects or
  restricts this, the iOS build ships without the Tor toggle rather than
  blocking the whole app — this must be decided explicitly, not discovered at
  submission time.
- **Push notifications leak "a message arrived" to Apple/Google by
  necessity.** We send content-free wake pings and treat Supabase Realtime as
  the actual delivery channel (see Milestone 3), but the existence and rough
  timing of a wake ping is visible to Apple/Google infrastructure. This
  matches Signal's own tradeoff, not a step back from it.

## Cryptographic foundation

We are not writing our own Double Ratchet / X3DH implementation. The crypto
core is `signalapp/libsignal` (Rust, audited, official Signal library),
wrapped for the app as a local Expo Module (`app/modules/signal-native-expo`,
see `packages/signal-native/README.md` for current status and how the two
relate). Any request to "just implement the crypto ourselves for
flexibility" should be treated as a red flag and pushed back on.

## Persistent key/session storage (Milestone 2.5 — done)

`packages/signal-native`'s `SignalDevice` now persists identity, sessions,
and prekeys to disk (`rust/src/store.rs`), encrypted with AES-256-GCM under
a 32-byte key custodied by `expo-secure-store` (Keychain on iOS, Keystore on
Android — see `app/src/crypto/masterKey.ts`). This closes the gap described
in earlier drafts of this document, where every app restart silently
generated a new identity and made all prior conversations permanently
undecryptable. Verified by `cargo test` actually dropping and reconstructing
a `SignalDevice` mid-conversation (`session_survives_simulated_restart`),
not just by writing files and assuming it works.

Persistence also surfaced a real bug worth naming: with only ever *one*
published one-time prekey per identity, the second peer to start a
conversation with someone (before that person's app relaunched) would find
the prekey table already emptied by the first peer's claim
(`claimPeerPrekeyBundle` deletes on claim — see
`app/src/transport/identities.ts`). `registerIdentity()` now publishes a
pool of 20 one-time prekeys per registration
(`generate_extra_one_time_prekeys` in `rust/src/lib.rs`,
`EXTRA_ONE_TIME_PREKEY_IDS` in `identities.ts`), proven by a dedicated
`cargo test` (`pool_of_one_time_prekeys_allows_multiple_concurrent_peers`)
where two peers independently claim different one-time prekeys from the same
identity's pool and both end up with working sessions. See the "no automatic
replenishment" gap below for what's still missing.

What this does **not** cover:

- **Losing the device, or the OS clearing Keychain/Keystore** (e.g. app
  uninstall/reinstall) still permanently loses the identity — there is
  intentionally no server-side backup of identity or session keys. A backup
  path would defeat much of the point of this design; if backup/multi-device
  is added later, it needs its own explicit threat-model entry, not a quiet
  bolt-on.
- **No key rotation yet.** The signed/Kyber prekey published at registration
  is only replaced when `registerIdentity()` runs again with a reason to
  (e.g. a fresh device), not on a schedule. Signal's own clients rotate
  periodically; this app doesn't yet.
- **The one-time prekey pool (20 per registration, see below) has no
  automatic replenishment.** If more than 20 peers start a session with an
  identity between two `registerIdentity()` calls, the 21st finds none left
  and `claimPeerPrekeyBundle` fails outright — there's no background
  top-up, only "the pool refills the next time the app restarts." Fine for
  now given the expected scale of manual, user_id-based conversation
  starts; would need real replenishment logic before this app has enough
  users for it to matter.
- **Decrypted plaintext is still never persisted** — `app/src/store/messagesStore.ts`
  stays in-memory-only by design (a message can only be decrypted once; the
  local plaintext is a cache of that one-time result, not something safe to
  redo from ciphertext later). The conversation list itself
  (`app/src/store/conversationsStore.ts`) is persisted, since it doesn't
  depend on ratchet state.
- **The local store file itself isn't further hardened** against a
  jailbroken/rooted device with the app unlocked — this falls under "a
  compromised endpoint device" above, which no messaging app defends against.

`FileIdentityKeyStore::is_trusted_identity` (store.rs) already does
trust-on-first-use *and* rejects a peer whose identity key changed since the
last session (proven by `establish_session_rejects_changed_peer_identity` in
`rust/src/lib.rs`) — this is the equivalent of Signal's "safety number
changed" warning, and it was already blocking silently before this was
wired up further. What changed: this now surfaces to the UI as a specific,
readable warning (`ERR_UNTRUSTED_IDENTITY` — see
`SignalNativeExpoModule.kt`/`.swift`, `crypto/index.ts::isUntrustedIdentityError`,
and the banners in `ConversationScreen.tsx`/`ConversationListScreen.tsx`)
instead of a swallowed `console.error` with no UI signal at all. Still
missing: any way to *deliberately* re-trust a peer after manually verifying
their new key out of band (no safety-number/fingerprint comparison UI
exists yet) — right now a changed identity permanently blocks that
conversation until the on-disk identity store is wiped.

## Disappearing messages

Every message carries a per-conversation TTL chosen by the sender
(`app/src/screens/ConversationScreen.tsx`, 30s to 1 week), enforced in two
independent places:

- **Server-side**: `expires_at` on the row, purged by `pg_cron` every minute
  (`supabase/migrations/0002_pg_cron_ttl.sql`) regardless of whether anyone
  ever opened the app to see the message.
- **Client-side**: `ConversationScreen` schedules local removal from
  `messagesStore` at the same `expires_at` — so a message vanishes from an
  already-open conversation live, not just on next fetch. A message that
  arrives already past its `expires_at` (a small race against the
  once-a-minute purge) is never decrypted at all — no point spending a
  one-time Double Ratchet message key on something about to disappear.

This is not the same guarantee as Signal's "timer starts when read" model —
here the timer starts at send time for everyone, which is simpler but means
a message sent with a long timer stays available longer than Signal's
"starts on read" semantics would. Worth revisiting if this becomes a real
product decision rather than a first pass.

## Screenshot protection

Always on app-wide (`App.tsx` → `hooks/useScreenshotProtection.ts`), no
per-conversation or Settings toggle — deliberately, to match this app's
private-by-default posture, unlike Signal's opt-in "Screen Security".

- **Android**: `expo-screen-capture`'s `usePreventScreenCapture()` sets
  `FLAG_SECURE`, which genuinely blocks screenshots and screen recording at
  the OS level (the exact mechanism banking apps and Signal's own Screen
  Security use) — not a false sense of security, it actually prevents the
  capture. Also blanks the app's preview in the recent-apps switcher, for
  free. Verified: `gradlew assembleDebug` succeeds with the module linked.
- **iOS**: Apple provides no API to block screenshots for any app (only
  screen *recording*, which the same hook call also covers on iOS 11+).
  A screenshot can only be detected after it already happened
  (`addScreenshotListener`), so the best available response is a local
  warning to whoever took it — no attempt to notify the other party, and no
  attempt to block. Deliberately not requesting Android's
  `READ_EXTERNAL_STORAGE` permission for the equivalent listener there,
  since Android already blocks the capture outright — there is nothing to
  detect.
- **What this does not do, on either platform**: stop someone from
  photographing the screen with a second physical device. No software
  mechanism can prevent that — this protects against casual in-app
  screenshotting/screen-recording, not a determined leak.

## Contact discovery

Until now, starting a conversation required already knowing the other
person's raw `user_id` (uuid) — and there was no screen anywhere showing a
user their *own* id, so in practice nobody could actually give it to anyone.
Closed by:

- **`MyIdCard.tsx`** (shown in `ConversationListScreen`'s empty state and in
  `SettingsScreen`) — displays the local user's own `user_id` as copyable
  text (`expo-clipboard`) and as a QR code (`react-native-qrcode-svg`).
- **`ScanQrScreen.tsx`** (`expo-camera`) — scans another device's QR and
  starts a conversation with the encoded `user_id`, via the same
  `startConversationWithPeer()` the manual-entry flow uses (extracted to
  `identity/startConversation.ts` so both share one code path instead of
  two).

This intentionally still doesn't add a username system or any
server-side lookup/search — the QR/text-share path never touches the
server at all (the id is exchanged directly between the two devices, or
through whatever channel the two people already trust to send it), keeping
the "no way to enumerate who's on this service" property intact. A
username-based discovery system remains a possible future addition but
trades away some of that property, so it wasn't the default choice here.

**Known cost**: `expo-camera`'s own Android manifest unconditionally
declares `RECORD_AUDIO` (it supports video capture generally, not just
barcode scanning, and Expo's config plugin option only suppresses the iOS
permission string, not the Android manifest entry) — this app never
requests or uses that permission at runtime, but it will still show up in
the Play Store's permissions disclosure. Not something fixable without a
custom manifest-patching config plugin, which isn't worth the fragility for
a permission that's declared but never actually invoked.

## App Store compliance (block, delete account, report)

Not a privacy/crypto requirement, but a hard launch blocker: Apple App Store
Review Guideline 1.2 (User-Generated Content) requires "the ability to block
abusive users" and "published contact information" for any app with
user-to-user communication; Guideline 5.1.1(v) requires in-app account
deletion for any app with account creation (anonymous sign-in counts).
Verified against Apple's current published guideline text before
implementing, not from memory.

- **Block**: `blocked_peers` table (`supabase/migrations/0007_blocking.sql`),
  enforced both directions inside `create_direct_channel` — a blocked
  identity can't start a new channel with the blocker, or vice versa.
  Verified live against the real API with two throwaway anonymous accounts
  (block → both directions rejected → unblock → works again). Client side:
  `store/blockedPeersStore.ts` (local cache, refreshed on
  `registerIdentity()`), a "Bloquear" action in `ConversationScreen.tsx`
  (hides the conversation locally too), and `BlockedPeersScreen.tsx` to
  unblock. Existing channels/messages with a since-blocked peer are NOT
  server-deleted — they age out via the existing TTL purge like any other
  conversation; only new channel creation is blocked and the conversation
  is hidden locally.
- **Delete account**: `supabase/functions/delete-account` Edge Function
  deletes the caller's own `auth.users` row via the Admin API (service-role
  key never reaches the client) after verifying their JWT — this cascades
  `identities`/`signed_prekeys`/`one_time_prekeys`/`channel_members`/
  `blocked_peers` automatically via existing FK constraints. Verified live:
  created a throwaway account, gave it real identity/channel/block data,
  called the deployed function, confirmed via SQL that every row was gone.
  Client side (`identity/deleteAccount.ts`) additionally wipes the on-disk
  encrypted Signal Protocol store (`SignalNativeExpoModule.kt`/
  `.swift::wipeLocalStore`) and the `expo-secure-store` master key — without
  this, a later "Criar identidade" would have silently reloaded the deleted
  account's old cryptographic identity from local disk instead of starting
  fresh. Reachable from `SettingsScreen.tsx`, behind a confirmation dialog.
- **Report**: given true E2EE, the server cannot see message content to
  moderate it — guideline 1.2's "filtering objectionable material" doesn't
  meaningfully apply here any more than it does to Signal itself. What's
  implemented instead (matching Signal's own approach): a "Denunciar" action
  in `ConversationScreen.tsx` that opens a prefilled `mailto:` to the
  support contact with the peer's `user_id`, letting the reporter describe
  or paste the offending content themselves.
- ~~Still missing~~ **Done**: `config/support.ts`'s `SUPPORT_CONTACT_EMAIL`
  is now `seixo.app@proton.me` — the report action and the Settings contact
  row both surface it.

## US export compliance (encryption)

Confirmed during the first `eas build --profile development-simulator
--platform ios` run: this app implements real non-exempt encryption for
message confidentiality (X3DH/PQXDH + Double Ratchet via
`libsignal-protocol`, plus AES-256-GCM for the local store — see
`packages/signal-native/`), not just OS-provided HTTPS/TLS. Answered
accordingly in the EAS/App Store Connect encryption prompts
(`ITSAppUsesNonExemptEncryption = true`).

**Still missing / blocking real (non-simulator, non-internal) distribution**:
actually filing the annual self-classification report with the US Bureau
of Industry and Security (BIS) that this "Yes" answer commits to. This has
no consequence for internal/simulator/dev-client builds — it only matters
once the app is distributed outside the developer's own EAS/Apple account
(TestFlight external testing, App Store release). Research and file this
before that point; not legal advice, get an actual read on current BIS
requirements before relying on this note.

## Native crypto module autolinking (found and fixed 2026-08-06)

The first real device run (a real iPhone, with a real Apple Developer
account) crashed on launch with `Cannot find native module
'SignalNativeExpo'`. Root cause: `app/modules/signal-native-expo` was
missing its own `package.json` and was never listed as a dependency of
`app/package.json`, so Expo's autolinking silently never discovered it on
*either* platform — Gradle/Xcode built the rest of the app and reported
success without ever attempting to compile this module. Compounding it,
`expo-module.config.json` declared the iOS platform as `"apple"` where this
Expo SDK's autolinking expects `"ios"`.

This means every prior "`gradlew assembleDebug` succeeds, crypto module
linked in" claim in this project's history (this file included) was a false
positive — the build succeeding never actually proved the module was part
of it. It stayed hidden because Android was never runtime-tested (no
emulator, no physical device ever available), and iOS had never been run at
all until this point. Fixed by adding the missing `package.json`, linking it
as a `file:` dependency, and correcting the platform key. Re-verified
properly this time: Android's `assembleDebug` output now shows real
`:signal-native-expo:*` Gradle subproject tasks (not just overall build
success), and `npx expo-modules-autolinking resolve --platform apple` — the
actual command the generated Podfile invokes — now correctly resolves the
module. A fresh EAS iOS build (the one that surfaced the bug predates the
fix) is still needed to confirm this on a real device.

**Lesson for future verification claims in this document**: "the build
succeeded" is not evidence a specific native module was included in it —
check for that module's own build tasks/output explicitly, the way this
entry now describes doing for Android.

### Follow-up: a second, compounding bug (same day)

A fresh EAS iOS build with the fix above still failed the same way on the
real device. Live debugging through the actual EAS build log (step by
step, with the user pasting each section) found a second, independent bug:
the `eas-build-post-install` hook that builds `SignalNative.xcframework`
(`packages/signal-native/rust/build-ios.sh`) was misnamed for what it
needed. Expo's own docs confirm `eas-build-post-install` runs *after*
`npm install`, `expo prebuild`, **and** `pod install` — but
`SignalNativeExpo.podspec` declares `s.vendored_frameworks =
'SignalNative.xcframework'`, a file only that hook produces. So at the
moment CocoaPods tried to resolve the podspec, the framework didn't exist
yet, and the pod was silently excluded (confirmed by comparing the "Install
pods" log's full list of installed pods against the "Fingerprint" step's
output, which *did* correctly list `signal-native-expo` — proving discovery
worked and the framework-timing was the actual remaining gap). Fixed by
renaming the hook to `eas-build-pre-install`
(`app/scripts/eas-build-pre-install.js`), which runs before `npm install` —
comfortably before `pod install` too. Rust/Xcode command line tools don't
need `node_modules` to exist first, so moving it earlier has no downside.

**Second lesson**: when a native module depends on a build artifact
produced by an EAS lifecycle hook, the hook's *name* determines pipeline
timing, not its filename or intent — verify the exact documented ordering
(https://docs.expo.dev/build-reference/npm-hooks/) rather than assuming
"post-install" means "right after `npm install`."

### Follow-up 2: still missing after the hook fix — a third suspect, confirmed

A third build, with the hook now confirmed running at the right point in the
pipeline (verified in the build's own step list — "Pre-install hook" now
runs second, right after "Spin up build environment"), *still* produced the
exact same 88-pods-no-SignalNativeExpo result in "Install pods." This means
the framework-timing theory, while a real and worthwhile fix, was not the
(or not the only) actual cause.

Found by comparing `SignalNativeExpo.podspec` against Expo SDK 52's own
minimum iOS target: the podspec declared `:ios => '16.4'`, but SDK 52 /
React Native 0.76 default to **iOS 15.1** project-wide — a real mismatch,
with nothing in `SignalNativeExpoModule.swift` or the uniffi-generated
Swift bindings actually requiring anything past basic Swift. Lowered to
`15.1` to match, and cleaned up two other podspec smells found at the same
time (`s.author = ''` and `s.source = { git: '' }`, both empty — set to a
real author and `{ path: '.' }` respectively).

**Confirmed**: the very next build's "Install pods" log shows
`Installing SignalNativeExpo (1.0.0)` and "89 dependencies... 89 total
pods installed" (previously always 88). The deployment-target mismatch was
the actual remaining cause — CocoaPods appears to silently drop a pod whose
declared minimum platform version exceeds what it can reconcile against the
rest of the Podfile's targets, rather than raising a hard error, which is
why this took three iterations to isolate (the two earlier bugs — missing
`package.json`/wrong platform key, and the hook-ordering issue — were both
real and worth fixing, but neither was sufficient on its own; all three
needed to be fixed together). The build log also shows some
`Can't merge pod_target_xcconfig for pod targets: [...]. Singular build
setting DEFINES_MODULE has different values` warnings involving a
`"Vendored"` target — these did not block `pod install` and are expected to
be harmless (CocoaPods warning about differing `DEFINES_MODULE` values
across unrelated pods), but are worth watching for if a subsequent Xcode
build step fails.

**Third lesson**: CocoaPods' own diagnostics (a plain `pod install` log)
don't surface a deployment-target mismatch as an error — it just silently
excludes the pod. When a pod is missing from "Install pods" with no error
anywhere in the log, check its `s.platforms` against the rest of the
project's actual baseline, not just autolinking discovery and hook timing.

**Fully confirmed (2026-08-06)**: the build installed cleanly on the real
iPhone and `Cannot find native module 'SignalNativeExpo'` no longer
appears. All three bugs (autolinking discovery, hook ordering, deployment
target) are now closed — the native crypto module is loaded and callable
from JS on both Android (real Gradle build) and iOS (real device). Runtime
correctness of the actual crypto calls (`initSignalDevice`,
`establishSession`, `encrypt`/`decrypt`) through this module on iOS is the
next thing to verify, not just that the module loads.

### Follow-up 3: App Store submission needs a newer EAS build image (Xcode 26)

Separate from the native module bugs above: the first `production` profile
build (triggered from the EAS/expo.dev dashboard via the GitHub
integration, not the CLI — see root `README.md`) succeeded but errored on
submission with `Starting April 28, 2026, Apple requires apps submitted to
the App Store to be built with Xcode 26 or newer. This build used Xcode
16.` Today's date is well past that deadline, so this is Apple's real,
currently-enforced requirement, not a future warning. EAS's default build
image for this project's Expo SDK version (52) predates Xcode 26.

Fixed by pinning a newer image explicitly for the `production` profile
only in `eas.json` (`ios.image: "macos-tahoe-26.5-xcode-26.6"`) —
deliberately not changed for `development`/`development-simulator`, which
are already confirmed working against the older default image and don't
need to satisfy Apple's App Store submission requirement (only builds
actually submitted to App Store Connect do). Worth watching: Xcode 26
compiling an Expo SDK 52 / RN 0.76 project is untested territory — if this
surfaces new Xcode/toolchain-version issues distinct from the three
already-fixed linking bugs, this is the first place to look.

That risk materialized immediately: the first `production` build under
Xcode 26 failed in "Run fastlane" with several `call to consteval function
'fmt::basic_format_string<...>' is not a constant expression` errors. This
is a known, widely-reported incompatibility (not specific to this
project): Xcode 26's Clang enforces stricter C++20 `consteval` rules than
the `fmt` 11.0.2 pod (pulled in transitively via `RCT-Folly`, this React
Native version's dependency) satisfies. Fixed upstream in `fmt` 12.1.0,
which only ships with React Native ≥ 0.83.9 / Expo SDK 56 — well past this
project's SDK 52, so a full SDK upgrade wasn't a reasonable fix to do in
the middle of debugging a build pipeline.

Instead, added `app/plugins/withFmtConstevalFix.js`, a small local Expo
config plugin (registered in `app.json`'s `plugins` array) that patches the
generated `ios/Podfile`'s `post_install` block to compile only the `fmt`
pod against the C++17 standard (where `consteval` doesn't exist as a
language feature, so `fmt` falls back to its working `constexpr` path) —
every other pod keeps the project's normal C++ standard. Written as a local
plugin rather than pulling in the third-party `expo-fmt-consteval-fix`
npm package that implements the same fix, specifically to avoid adding an
unaudited dependency into the build pipeline of an E2EE app — this
project's threat model is exactly the kind of context where "just install
a package for it" carries real cost. `ios/Podfile` is gitignored (generated
fresh by `expo prebuild` on every build, per `app/.gitignore`'s `/ios`
entry), so this has to be a config plugin, not a one-off manual edit.

**First attempt had a real bug**: the first version located the injection
point by regex-matching the `end` that *closes* the `post_install do
|installer|` block. `pod install` failed with `undefined local variable or
method 'installer'` — the non-greedy regex matched the first `\nend`
it found, which turned out to be a *nested* block's `end` (RN's own
`post_install` body includes further `installer....each do |x| ... end`
constructs), so the injected code landed just after the outer block had
already closed, out of `installer`'s scope. Locating a Ruby block's closing
`end` by regex isn't reliable in general — Ruby's grammar isn't regular,
and nested `do...end` constructs make "the next `end`" ambiguous. Fixed by
inserting immediately *after* the block's opening line instead
(`post_install do |installer|\n`) — unconditionally inside the block no
matter what follows, sidestepping the whole "find the matching close"
problem. Verified against a sample Podfile shape with nested `each` blocks
mimicking the real one that broke the first attempt.

Remove this plugin once the project upgrades past React Native 0.83.9 /
Expo SDK 56.

This product must not be exposed to real users carrying real conversations
before an external security audit of at least: the `signal-native` crypto
integration, the Supabase RLS policies, and the TTL purge logic. This is
listed as Milestone 5 in the project plan and is non-negotiable for a "real
product" launch (as opposed to a personal prototype).
