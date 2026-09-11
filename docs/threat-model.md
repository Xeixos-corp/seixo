# Threat model (initial draft — Milestone 0)

This is a living document. It exists so that every later decision ("can we
skip this?", "is this good enough to launch?") gets checked against something
written down instead of vibes. Treat any claim here as invalid once the
underlying implementation (linked file) changes without this doc being updated.

## What we're protecting against

- **A passive network observer** (ISP, Wi-Fi operator, on-path attacker)
  should not learn message content. Note that such an observer *can* still
  see that this device talked to the backend, and when — see the Tor note
  below; nothing in this app hides that today.
- **The backend operator** (us, or Supabase Inc. if Cloud is used during dev)
  should never see plaintext message content. On *who sent what*, the honest
  claim is narrower than this document used to make — see "What 'sealed
  sender' here does and does not mean" below.
- **A device compromise after the fact** should not retroactively expose past
  conversations forever — this is why messages carry `expires_at` and are
  purged server-side by `pg_cron` regardless of whether the recipient ever
  opened the app (`supabase/migrations/0002_pg_cron_ttl.sql`).

## What we are explicitly NOT protecting against (yet, or ever)

- **A compromised endpoint device** (malware, physical access with the device
  unlocked, coerced unlock). No messaging app can defend against this; screen
  lock + OS-level encryption is the user's responsibility.
- **Global passive adversaries correlating traffic timing across the entire
  network** (traffic analysis at nation-state scale). Tor *would* raise the
  cost of this without making it impossible — but Tor is not implemented (see
  below), so at present nothing here raises that cost at all.
- **Zero server-visible metadata.** This is not achievable with any
  centralized backend, self-hosted or not. What we commit to is *minimizing
  and time-limiting* what the server holds, not eliminating it. Concretely,
  the server (whoever operates the Postgres instance) still learns:
  - Which opaque `channel_id`s exist and which `user_id`s belong to them
    (`channel_members` table) — this is unavoidable; the server has to know
    who is authorized to read a channel to enforce RLS and route delivery.
  - **Connection IP and request timing, always.** There is no Tor toggle and
    no other IP-hiding path in the app today (see below), so the backend —
    and Supabase Inc. while Cloud is in use — sees the real client IP of
    every request.
  - Approximate message size and frequency (ciphertext length, insert rate),
    even though content and sender-within-a-message are hidden.

## Known platform-specific gaps

- **Tor is NOT implemented. There is no Tor toggle, on any platform.**
  Earlier drafts of this document described one as though it existed
  ("when Tor is enabled", "unless the client is using the Tor toggle") —
  that was aspirational text from the original project plan, where Tor is
  Milestone 4, and it was never built. Verified 2026-09-05: no Tor code, no
  dependency, no `src/tor` directory. Corrected here rather than left to
  mislead, especially now the repository is public.

  When it is built, the known constraints still apply: Apple's review
  process and background-execution restrictions make an always-on embedded
  Tor daemon much less reliable on iOS than on Android, so the iOS build may
  end up shipping without it. That is a decision to make explicitly, not to
  discover at submission time.
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
- **Decrypted plaintext IS now persisted locally** (changed 2026-09-05;
  `app/src/store/messagesStore.ts`). It previously was not, which sounded
  stronger than it was: because decrypting consumes a Double Ratchet message
  key, the in-memory copy was the only one that would ever exist, so closing
  the app destroyed every conversation permanently. That is not a messenger,
  and an app nobody can use protects nobody.

  What this costs, stated plainly: message text now sits on disk in the app
  container. On iOS that is encrypted at rest by the OS and tied to the
  device passcode; this app adds no second layer of its own. The
  "compromised endpoint device, unlocked" case was already out of scope
  above, and an app lock (biometrics with device-passcode fallback) covers
  the everyday "someone picks up my unlocked phone" case.

  Expired messages are dropped during hydration rather than restored, and
  restored messages get their disappearing timers rescheduled on mount —
  without both, restarting the app would quietly undo disappearing messages.
  The conversation list (`app/src/store/conversationsStore.ts`) was already
  persisted, since it never depended on ratchet state.
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
instead of a swallowed `console.error` with no UI signal at all. **Both gaps closed on 2026-09-10** — see "Verifying a contact" below.

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

The conversation's timer is a ceiling, not a fixed rule: a long press on the
send button arms a shorter one for the next message only. The chosen lifetime
travels with that message in both directions -- the server is asked to drop
the row at that point, and the payload carries `l` so the recipient's device
schedules its own removal on the same clock instead of the conversation's.
It can only ever shorten, never extend, so a recipient cannot be given a
message that outlives what the conversation agreed to.

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

**Attempt 1 (Podfile plugin, abandoned)**: added
`app/plugins/withFmtConstevalFix.js`, a local Expo config plugin patching
the generated `ios/Podfile`'s `post_install` block to compile only the
`fmt` pod against the C++17 standard (where `consteval` doesn't exist as a
language feature). Written as a local plugin rather than pulling in the
third-party `expo-fmt-consteval-fix` npm package that implements the same
fix, specifically to avoid adding an unaudited dependency into the build
pipeline of an E2EE app. Its first version had a real bug of its own:
it located the injection point by regex-matching the `end` that *closes*
the `post_install do |installer|` block, and the non-greedy regex matched
a *nested* block's `end` instead (RN's own `post_install` body has further
`installer....each do |x| ... end` constructs) — `pod install` failed with
`undefined local variable or method 'installer'`, since the injected code
landed just after the outer block had already closed. Fixed by inserting
right after the block's *opening* line instead, sidestepping the "find the
matching close" problem entirely — `pod install` then succeeded and
`SignalNativeExpo` still installed correctly. But the actual Xcode archive
step **still failed with the identical consteval error, unchanged** — the
C++17 override on the `fmt` target evidently didn't survive to the actual
compile. Most likely explanation: React Native's own `react_native_post_install`
helper (called earlier in the same block, since our injected code runs
right after the block opens but the RN call is the next statement) also
normalizes C++-language-standard build settings across pods, plausibly
superseding our per-target override. Rather than chase exact Podfile
statement ordering/precedence further, abandoned this approach — deleted
`app/plugins/withFmtConstevalFix.js` and its `app.json` registration.

**Attempt 2 (header patch via a new EAS hook, applied)**: added
`app/scripts/eas-build-post-install.js`, wired to `package.json`'s
`eas-build-post-install` hook — deliberately the sibling of, not a
replacement for, the project's existing `eas-build-pre-install` hook (see
the earlier "Follow-up: a second, compounding bug" entry above): that one
must run *before* `pod install` (to build the xcframework in time), this
one must run *after* it (it patches a file, `ios/Pods/fmt/include/fmt/base.h`,
that doesn't exist until CocoaPods has vendored `fmt`). Both hook names are
independent and EAS runs both at their respective correct pipeline stages.
The patch itself: flip a single line in `fmt`'s own `FMT_USE_CONSTEVAL`
feature-detection (`#elif defined(__cpp_consteval)` →
`#elif defined(__cpp_consteval) && !defined(__apple_build_version__)`),
so `fmt` never takes the broken consteval code path when compiled by any
Apple Clang fork specifically (detected via the `__apple_build_version__`
macro), falling back to its ordinary working `constexpr`-based path
instead — a small, well-scoped, community-confirmed fix
(https://bleepingswift.com/blog/fmt-consteval-error-xcode-26-4-react-native)
that patches source text directly rather than relying on build-setting
precedence that turned out to be unreliable. Exact target string verified
against fmt 11.0.2's actual `include/fmt/base.h` source before writing the
patch. Fails loudly (non-zero exit) if the target string isn't found,
rather than silently shipping an unpatched build.

**First version of this fix also didn't work** — two real bugs, both now
fixed:

1. `EACCES: permission denied` writing to `fmt/base.h` — CocoaPods installs
   vendored pod sources read-only by default, and the script tried to
   `fs.writeFileSync` without first making the file writable. Fixed with
   `fs.chmodSync(path, 0o644)` before the write.
2. After fixing (1), the archive step failed with the **exact same,
   byte-for-byte identical** consteval errors, meaning the patch itself had
   zero effect even though it ran successfully. Reading fmt 11.0.2's full
   `FMT_USE_CONSTEVAL` preprocessor chain (not just the one line originally
   patched) revealed why: it has *two* independent `#elif` branches that
   each separately set `FMT_USE_CONSTEVAL` to 1 —
   `#elif defined(__cpp_consteval)` (the one originally patched) and
   `#elif FMT_GCC_VERSION >= 1002 || FMT_CLANG_VERSION >= 1101`. fmt's
   `FMT_CLANG_VERSION` macro (`__clang_major__ * 100 + __clang_minor__`)
   does *not* special-case Apple's clang the way the chain's own
   `__apple_build_version__ < 14000029L` check (further up the same chain,
   pre-existing in fmt, meant for *old* Apple clang) does — it treats Apple
   clang's self-reported version numbers the same as upstream LLVM clang,
   and Xcode 26's Apple clang reports high enough numbers to satisfy
   `>= 1101` regardless. So excluding Apple's clang from only the first
   branch left the second branch to independently reach the same
   `FMT_USE_CONSTEVAL = 1` outcome. Fixed by excluding Apple's clang from
   *both* branches. This is the kind of bug that a "the fix ran without
   error" check alone would miss — only re-running the actual Xcode archive
   step and comparing the error text surfaced that the patch had done
   nothing.

**Confirmed fixed**: the next build compiled `fmt/format.cc` with zero
consteval errors and archiving progressed well past it — all the way to
actually compiling `SignalNativeExpo` itself (the module this whole
multi-bug saga started over).

Remove this part of the hook once the project upgrades past React Native
0.83.9 / Expo SDK 56, at which point `fmt` itself (bumped to 12.1.0) no
longer needs the workaround.

### Follow-up 4: a second, unrelated Xcode 26 toolchain bug — expo-localization

With the `fmt` bug closed, the same build failed at a new, unrelated point:
`SwiftCompile` on `node_modules/expo-localization/ios/LocalizationModule.swift`,
auto-detected as `switch must be exhaustive`. Same underlying cause as
`fmt` (Xcode 26 shipping a stricter toolchain than this project's pinned
dependencies were built against) but a completely different mechanism:
Swift now requires an exhaustive `switch` over `Calendar.Identifier` (a
non-frozen enum from Foundation that can gain new cases across OS/SDK
versions), and `expo-localization`'s `~16.0.1` (this project's pinned
version, matching Expo SDK 52) predates whichever `Calendar.Identifier`
case the Xcode 26.1 / iOS 26 SDK combination added. Confirmed as a known,
already-reported upstream issue affecting the exact same combination
(expo ~52.0.47, Xcode 26.1): https://github.com/expo/expo/issues/40849 —
not fixed in any SDK-52-compatible `expo-localization` release as of this
writing.

`app/scripts/eas-build-post-install.js` was refactored into a small
`patchFile()` helper (idempotent, fails loudly if its target text isn't
found — same philosophy as the `fmt` patch) and reused for this second,
unrelated file: adds `@unknown default: return "gregory"` to the switch —
Swift's purpose-built mechanism for exhaustively handling a non-frozen
system enum without enumerating every case, falling back to Gregorian
(ISO/BCP-47's calendar default) for any identifier newer than this file
knew about. Unlike the `fmt` file (only present after `pod install`), this
one lives under `node_modules/` and exists as soon as `npm install`
finishes — it didn't strictly need to run this late in the pipeline, but
there was no reason to split it into a different hook either.

**First version of this patch had a bug too**: it assumed the switch's
`case`/`return`/closing-`}` used 0/2/0-space indentation (matching a
top-level declaration), and failed loudly (as designed) with "could not
find" rather than silently no-op'ing — but it still needed a second
iteration to actually work. The real cause: `getUnicodeCalendarIdentifier`
is a `static func`, so its switch sits one indentation level deeper than
assumed (4-space `case`, 6-space `return`, 4-space closing `}`). Fixed by
fetching the *exact* published `expo-localization@16.0.1` package source
(not just eyeballing a similar-looking snippet) and byte-for-byte
confirming the corrected target string matches before shipping the patch —
this project's `~16.0.1` semver range resolves to exactly that version (no
newer non-canary 16.0.x release exists), so there's no ambiguity about
which source to check against.

Remove once `expo-localization` ships a fix and this project upgrades to
that version.

### Resolved: first successful `production` iOS build (2026-08-07)

`main @ 2f0295f` (this entry's own commit) produced the first fully
successful `production`-profile iOS build: archive, sign, and export all
completed in 7m38s. This closes out the entire chain of build-pipeline
bugs documented across this section and its four follow-ups, discovered
and fixed over one extended debugging session:

1. Native module autolinking (missing `package.json`, wrong `"apple"` vs
   `"ios"` platform key).
2. EAS hook ordering (`eas-build-post-install` running after `pod install`
   instead of before, for a hook whose output `pod install` depended on).
3. `SignalNativeExpo.podspec` deployment target mismatch (16.4 vs the
   project's actual 15.1 baseline) — CocoaPods silently drops a pod over
   this rather than erroring.
4. `fmt` 11.0.2 vs. Xcode 26's stricter C++20 `consteval` enforcement, in
   two independent branches of `fmt`'s own feature-detection.
5. `expo-localization` 16.0.1's non-exhaustive `Calendar.Identifier`
   switch, also an Xcode 26 strictness change.

Plus two build-infrastructure issues along the way: the EAS default build
image predating Apple's Xcode-26 App Store submission requirement, and a
missing distribution-certificate/provisioning-profile bootstrap that
needed one interactive `eas build` run before dashboard-triggered
(non-interactive) builds could work.

**What's now proven**: the app archives and signs cleanly for App Store
distribution. **What's still unverified**: that the resulting build
actually installs and runs correctly on a real device (submission to
TestFlight and an on-device install are the next steps — see root
`README.md`), and that the Signal Protocol calls themselves
(`initSignalDevice`, `establishSession`, `encrypt`/`decrypt`) work
correctly through the now-confirmed-loading native module on iOS, as
opposed to just Android (see `packages/signal-native/README.md`).

### Follow-up 5: first App Store Connect submission rejected — export compliance documentation

The first `eas submit` of the successful build above uploaded cleanly but
was rejected minutes later by Apple with `ITMS-90592: Invalid Export
Compliance Code` — `app.json`'s `ITSAppUsesNonExemptEncryption: true` is
correct (the app genuinely implements E2EE beyond HTTPS, via
`signal-native`/`libsignal`), but that declaration alone isn't sufficient
for a first-ever submission: Apple also requires "App Encryption
Documentation" to be filed once per app, separately, in App Store
Connect's own UI (App Information → App Encryption Documentation), and
rejects any binary uploaded before that's on file.

**Important — this is not the same thing as toggling
`ITSAppUsesNonExemptEncryption` to `false`** to make the error disappear;
several online guides suggest exactly that, but it would misrepresent an
app that has real non-exempt encryption to Apple, which this app does. The
correct fix is filling out the actual questionnaire honestly:

1. Purpose/description of the app (free text).
2. Which category of algorithm the app uses: proprietary/non-standard
   (unchecked — `libsignal` uses standard, published algorithms: AES-256-GCM,
   Curve25519/X25519, Kyber, HKDF) vs. standard algorithms used *instead
   of, or in addition to,* Apple's own OS-level encryption (checked — the
   app embeds its own crypto via `libsignal` rather than relying solely on
   Apple's Security/CryptoKit frameworks).
3. Whether the app should be available for distribution in France
   specifically (that country has its own additional cryptography import
   declaration requirement via ANSSI) — answered "No" for now, during the
   testing phase; revisit before any real public/multi-country launch.

Each time, App Store Connect's own wizard determined "no document upload
is required" — implying an immediate self-classification, no BIS paperwork
or multi-day Apple review needed. After filing it, the *same*
already-built binary (no new `eas build` needed) was resubmitted via
`eas submit` again, selecting the same build ID from EAS's build list.

**This did not actually fix it.** The identical `ITMS-90592` rejection
recurred on resubmission of the exact same binary, twice, across two
separate completions of the questionnaire (once via the "+" entry point,
once via "Carregar" — both landed on the same 3-question flow and the same
"no document needed" outcome, but the app-level "App Encryption
Documentation" summary view kept showing an empty/unfilled state
afterward each time, suggesting neither attempt actually persisted a
record App Store Connect's own ingest-time validator can see).

Ruled out a client-side/EAS bug as the cause: downloaded the actual
uploaded `.ipa`, extracted it, and parsed `Payload/Seixo.app/Info.plist`
directly with Python's `plistlib` (binary plist format — not
human-readable as-is). Confirmed `ITSAppUsesNonExemptEncryption` is
present and `True` in the real shipped binary, exactly as `app.json`
declares. This rules out the hypothesis that EAS/Expo's config plugin
pipeline was silently dropping or mismatching the value (a real, if
different, issue reported in `expo/eas-cli` GitHub issues around
`ios.config.usesNonExemptEncryption` not always being read — not what's
happening here, since the raw `ios.infoPlist.ITSAppUsesNonExemptEncryption`
path this project uses does reach the binary correctly).

Given the binary is confirmed correct and App Store Connect's own
self-service questionnaire doesn't appear to be persisting a matching
record, escalated directly to Apple Developer Support via
developer.apple.com/contact (App Setup → Encryption category) — **Case ID
20000131555931**, filed 2026-08-08. That category turned out to be the
wrong one: Apple's reply said "This is an error that I cannot assist
with" and redirected to **App Setup → Binary Delivery and Processing**
instead. Re-filed there as a follow-up referencing the first case —
**Case ID 20000133386355**, filed 2026-08-08. No reply arrived within a
few days; replying directly to the (no-reply) notification email got no
response either, so followed up properly through the case's own page
(developer.apple.com/contact → "Get help with a recent issue" →
"View my recent cases" → the case → Email), which keeps a follow-up tied
to the existing case rather than opening a new one. Still awaiting a
substantive reply. The
BIS/NSA annual self-classification report (drafted but not yet sent —
would need the app's mass-market ECCN 5D992, `MMKT` authorization type,
and the account holder's personal contact details) is on hold pending
Apple's diagnosis, since it's not yet confirmed that filing it would even
resolve this specific rejection (Apple's own compliance record, not a
missing government filing, looks like the more likely proximate cause).
The ad-hoc `development` build profile (Tier 2 in root `README.md`)
remains fully functional as a fallback for testing with a second device in
the meantime, sidestepping App Store Connect entirely.

With Apple Developer Support still silent after several days, tried the
lower-effort fallback next: bumped `app.json`'s `version` from `1.0.0` to
`1.0.1` (a genuinely new version, not just a new build number under the
same version) on the theory that the *specific* version 1.0.0 record in
App Store Connect might be the thing stuck in a bad state from the
repeated submission attempts, and a fresh version might correctly pick up
the (believed-to-be-already-saved) app-level Export Compliance
Documentation.

**This theory is now disproven.** The `1.0.1` build hit the exact same
`ITMS-90592` rejection, byte-for-byte identical error text. This rules out
"a specific version's record is stuck" as the cause — whatever's wrong is
scoped to the whole app (App Apple ID 6799254811) or the developer
account, not a single version.

Given this, and given the project's EAS free-tier build quota is nearly
exhausted (12/15 iOS builds used before this one — see the courtesy email
from Expo), a fresh Bundle ID (a genuinely new App Store Connect app
record) — which would cost another scarce build just to test the
hypothesis — is being held back further still. Next, actually sending the
BIS/NSA annual self-classification report (drafted earlier, held pending
Apple's diagnosis, which never came) — zero build cost, and Apple's own
self-service questionnaire repeatedly claiming "no document needed" may
simply be wrong, or may be silently assuming a government filing already
exists that this project doesn't actually have yet.

### Resolved: ITMS-90592 root cause — and a correction (2026-09-04)

After Apple Developer Support proved unable to help across two cases
(20000131555931, 20000133386355 — the second answered only with a generic
documentation link that pointed back to the process already followed), the
answer came from **looking at what real E2EE apps actually ship**, rather
than from parsing Apple's prose any further:

| App | `ITSAppUsesNonExemptEncryption` | `ITSEncryptionExportComplianceCode` |
| --- | --- | --- |
| **Signal-iOS** (authors of `libsignal`) | `false` | absent |
| **Element-iOS** (Matrix, E2EE) | `true` | `d1dd539c-d21c-43e2-92e2-212c5269565c` |
| **Seixo, before this change** | `true` | **absent** |

**No shipping app is in the state this project was in** (`true` with no
code) — which is precisely the state `ITMS-90592` rejects. The `[]` in the
error text is the *empty* `ITSEncryptionExportComplianceCode`, not a
problem with `ITSAppUsesNonExemptEncryption`.

**Correction to earlier entries in this section**: this document (and the
assistant working on it) previously asserted that `true` was the only
honest value and that `false` would be a material misrepresentation. That
was wrong, and stated with more confidence than the evidence supported.
Signal — same crypto library, serious legal counsel — ships `false`.

The reason `false` is legitimate for Signal is *not* the algorithms; it is
**the form and manner of distribution**. From Signal-iOS's own README: BIS
classifies the software as ECCN 5D002.C.1, and "the form and manner of this
distribution makes it eligible for export under the License Exception ENC
Technology Software Unrestricted (TSU) exception (BIS EAR §740.13)". TSU
turns on the source being *publicly available*. BIS is explicit that an
item is **not** publicly available merely because it incorporates or calls
publicly available open source — so a closed-source app linking `libsignal`
does not inherit Signal's basis.

**Decision (2026-09-04): make this repository public**, which does three
things at once:

1. Establishes the TSU basis, making `false` accurate rather than a
   convenient lie — so `app/app.json` now sets
   `ios.infoPlist.ITSAppUsesNonExemptEncryption` to `false`, and no
   Apple-issued compliance code is needed.
2. Resolves an **independent licensing problem found during the same
   investigation**: `libsignal` is **AGPLv3**. Shipping a closed-source app
   linked against it was very likely a license violation, unrelated to
   export compliance. Signal can do it because they own the copyright; this
   project cannot.
3. Aligns with the norm for credible cryptography: closed-source crypto is
   treated with suspicion, and publishing is what makes an external audit
   (Milestone 5) meaningful in the first place.

Secret scan before publishing (git history, all refs) found: no JWTs or
Supabase anon keys, no `service_role` key, no private keys or certificates,
no Apple credentials, no hardcoded passwords; the real `app/.env` is
gitignored and was never committed. Only `.env.example` templates are
tracked. The Supabase project ref (`zopexbtdbqboijysmpuy`) does appear in
`supabase/README.md`, but it is not a credential — it is visible in the
app's network traffic to anyone who installs it. It does mean **RLS is now
the sole barrier**, which is the intended design but raises the stakes;
`get_advisors` currently reports only WARN-level items, nearly all of them
inherent to this app's deliberate use of anonymous sign-in. One genuine
hardening item is open: `create_direct_channel` and `is_channel_member` are
`SECURITY DEFINER` and executable by the `anon` (not-signed-in) role.

**Two steps remain that only the account holder can perform**, and the
`false` declaration is not yet valid until both are done:

- Flip the GitHub repository to public.
- Send the one-time TSU notification to BIS and NSA with the repository
  URL (EAR §740.13(e)) — this is what activates the exception.

`README.md` now carries a Cryptography Notice modelled on Signal's,
including an explicit warning that the `false` value depends on the
repository staying public.

### Hardening: unauthenticated RPC access closed (2026-09-04)

Publishing the repository made the Supabase project ref public, which puts
all the weight on RLS. `get_advisors` flagged that both `SECURITY DEFINER`
helpers were reachable by the `anon` role — i.e. by anyone holding the
publishable key, with no account at all. Cause: PostgreSQL grants `EXECUTE`
to `PUBLIC` by default on new functions; `0003`/`0004` added
`grant execute ... to authenticated` but never revoked that default, and
`0004` additionally granted `is_channel_member` to `anon` outright.

Neither function could corrupt data from an unauthenticated call —
`channel_members.member_id` is `NOT NULL`, so `create_direct_channel`'s
insert fails and rolls back when `auth.uid()` is NULL. The real exposure was
**metadata**, which is the thing this document commits to minimising:

- `create_direct_channel` returns a distinguishable `peer identity not
  found` versus a constraint violation, giving an anonymous caller who holds
  a `user_id` a way to confirm that person is a Seixo user.
- `is_channel_member` answers "is user X in channel Y?" directly, to anyone,
  with no session — exactly the channel-membership metadata that is supposed
  to be readable only by members.

`supabase/migrations/0008_revoke_public_function_access.sql` revokes
`EXECUTE` from `PUBLIC` and `anon` on both, keeping it for `authenticated`.
Safe because `registerIdentity`'s `doRegister()` awaits
`signInAnonymouslyIfNeeded()` before any query, so every real client is
`authenticated`. Verified after applying: `pg_proc.proacl` now lists only
`authenticated`/`postgres`/`service_role`; a role-switch test confirmed
`authenticated` can still call `is_channel_member` while `anon` is rejected
with `insufficient_privilege`; and both `anon_security_definer_function_executable`
advisories are gone. The advisories that remain are by design (signed-in
users *must* be able to call these; anonymous sign-in is the auth model;
leaked-password protection is irrelevant to a passwordless app).

### Startup crash and blank screen on the first real TestFlight builds (2026-09-04)

Two unrelated defects, found in sequence once builds finally reached a
device. Worth recording because the first was invisible from the code and
the second was invisible from the crash report.

**1. Uncaught NSException from an async void TurboModule (React Native bug).**
Builds 1.0.1 (2) and (3) died ~260ms after launch, `EXC_CRASH (SIGABRT)`.
The symbolicated report from App Store Connect named the line:

    __cxa_rethrow / objc_exception_rethrow
    ObjCTurboModule::performVoidMethodInvocation  (RCTTurboModule.mm:426)
    _dispatch_call_block_and_release -> std::__terminate -> abort

This is facebook/react-native#54859. A TurboModule method returning void
runs its `@catch` on the module's dispatch queue when invoked
asynchronously, so anything thrown escapes into libdispatch with no
handler. React Native already fixed this for the *synchronous* entry point
(`performMethodInvocation`, PR #50193 — `if (isSync) { throw ... } else {
@throw exception; }`) and left the void variant rethrowing
unconditionally. Debug builds are unaffected, which is why the
`development` profile ran fine on the same iPhone 16 Pro / iOS 26.6.1
(expo/expo#44680 reports the same signature on A18 Pro + iOS 26).

The crash report cannot name the module that threw — the original throw
site is gone by the time it is rethrown. Rather than guess, patched the
React Native source itself via `app/scripts/eas-build-post-install.js`
(patch 3): keep the throw on the sync path, log module + method name on
the async path. That fixes the crash whatever the culprit is, *and* makes
the culprit visible. One hypothesis was tested and disproven first
(`expo-screen-capture`'s `preventScreenCaptureAsync`, the app's only
unconditional async-void call at startup) — build (3) shipped that change
alone and crashed identically, so it was reverted rather than leaving iOS
without screen-recording protection for nothing.

Verified the patch actually shipped by downloading the built `.ipa` and
grepping the executable for the patch's own log string, rather than
assuming the hook ran.

**2. `EXPO_PUBLIC_*` never reached the bundle (this project's bug).**
With the crash fixed, build (4) launched to a blank white screen. Cause:

    const env = process.env as Record<string, string | undefined>;
    const supabaseUrl = env.EXPO_PUBLIC_SUPABASE_URL;

Expo substitutes `EXPO_PUBLIC_*` at build time by *static* replacement of
`process.env.NAME` member expressions. Assigning `process.env` to a local
first defeats it, so both values were `undefined` in the production
bundle, `supabaseClient.ts` threw during module import, React never
mounted, and a release build shows nothing at all. It worked in the dev
client because `process.env` is populated at runtime there — so the bug
could only ever appear in a production build.

Diagnosed by grepping `main.jsbundle` inside the shipped `.ipa`: the only
occurrence of `EXPO_PUBLIC_SUPABASE_URL` was inside the error message.
Fixed by reading them as bare member expressions.

**A cast is not an acceptable way to silence the resulting type error.**
Both forms were tested with a local `npx expo export --platform ios` and
the output bundle grepped for the real URL:

| Form | `tsc` | Inlined |
| --- | --- | --- |
| `const env = process.env; env.EXPO_PUBLIC_X` | passes | **no** |
| `(process.env as Record<...>).EXPO_PUBLIC_X` | passes | **no** |
| `process.env.EXPO_PUBLIC_X` | errors | **yes** |

Babel's substitution runs before TypeScript's types are stripped, so any
`TSAsExpression` wrapper stops it matching. The bare form plus a narrow
`@ts-expect-error` is therefore the only combination that is both correct
and typechecked. `npx expo export` + grep is the cheap way to verify this
class of problem without spending an EAS build.

### Manual message deletion is best-effort against the peer (2026-09-05)

Long-pressing a message deletes it ahead of its TTL, using the RLS policy
that has existed since `0001_init.sql` ("messages are deletable by channel
members (manual delete / burn)") but was never wired to any UI.

What it actually guarantees, since this is easy to overstate:

- **Reliable**: the server's copy is gone, and so is this device's.
- **Best-effort**: the peer drops their copy only if their client is
  subscribed when the delete lands. Their local history is now persisted
  (see above), so a peer who was offline at that moment keeps it — nothing
  re-checks the server for deletions after the fact.
- **Not covered at all**: a screenshot, or another phone photographing the
  screen. The same limit the screenshot warning already acknowledges.

The confirmation dialog states all three rather than implying deletion is
absolute, and the action is labelled "Delete now" rather than "Delete for
everyone" for the same reason.

`supabase/migrations/0009_messages_replica_identity_full.sql` was needed to
make the peer half work: Postgres puts only the primary key in the WAL by
default, so a DELETE event arrives with no `channel_id` — the client's
filter has nothing to match and Realtime cannot evaluate the RLS policy to
decide who may receive it. `REPLICA IDENTITY FULL` puts the whole old row
there instead. That widens what flows through replication to include the
ciphertext, but only to subscribers who pass the existing policy — members
of that channel, who already hold that exact ciphertext — so it exposes
nothing to anyone who did not already have it. It does make the WAL
heavier, which matters if message volume ever grows.

### A transient failure could brick registration permanently (2026-09-05)

Worth recording because the failure mode was self-perpetuating and the
symptom pointed away from the cause.

`subscribeToMyNewMemberships` opened a Realtime channel named
`channel-members-self-<userId>` — stable per user, so it collides with
itself. supabase-js returns the existing instance for a topic it already
knows, and calling `.on()` on one that has already been subscribed throws
`cannot add postgres_changes callbacks … after subscribe()`.

`registerIdentity` memoizes its promise and clears the memo when
`doRegister` fails, so the next call retries. But the retry re-ran this
subscription, hit the already-subscribed channel, and failed for a
*different* reason than the original — which cleared the memo again. Every
attempt after the first failure failed this way, so a momentary network
problem left the app unable to register until it was restarted.

Found because Settings showed "could not load your ID" and retrying never
helped. Two earlier decisions are what made it findable at all: MyIdCard
used to `return null` on failure (so the whole card silently wasn't there),
and its `catch` was empty. Rendering the failure, then rendering the error
text itself, turned "the QR code isn't in Settings" into an exact message.

Fixed by giving each subscription its own topic and tearing down the
previous one, so a repeat call cannot collide with itself. The original
trigger — whatever failed first — is still unknown and may well have been
a network blip; what mattered was that one blip became permanent.

**Lesson**: retry paths need to be idempotent, or the retry becomes the
bug. And empty catch blocks do not make failures go away, they make them
unattributable.

This product must not be exposed to real users carrying real conversations
before an external security audit of at least: the `signal-native` crypto
integration, the Supabase RLS policies, and the TTL purge logic. This is
listed as Milestone 5 in the project plan and is non-negotiable for a "real
product" launch (as opposed to a personal prototype).

### App lock, and push notifications without a sender column (2026-09-05)

Two features that both touch this document's claims directly, so both are
recorded here rather than only in commit messages.

**App lock (Face ID / device passcode).** Message history is now stored on
disk (see the note in `app/src/store/messagesStore.ts` about why that was
worth doing). "A compromised endpoint device, unlocked" remains explicitly
out of scope above and still is — this does not change that. What it covers
is the much more ordinary case that was silently lumped in with it: an
already-unlocked phone picked up by someone else. `AppLockGate` sits inside
the theme provider but outside the navigator, so nothing behind the lock is
ever mounted, and re-locks on `AppState` `background` (not `inactive`, which
iOS also reports for the Face ID sheet itself and for notification-shade
pulls).

One deliberate weakening: if no credential is enrolled any more — the user
turned the lock on and later removed their passcode — `unlock()` returns
`unavailable` and the app opens. Refusing would be a permanent, unrecoverable
lockout: history lives only on this device (decryption consumes the ratchet
key, so the server's copies can never be read again) and there is no account
password to fall back on. A lock that can brick the app is worse than one
that yields when the OS has nothing left to check. Enabling the lock is
blocked in the first place unless hardware *and* an enrolled credential both
exist.

**Push notifications, and why they add no server-visible metadata.** The
obvious implementation — "notify everyone in the channel except the sender" —
needs to know who the sender is, which `messages` deliberately does not
record (sealed sender, `supabase/migrations/0001_init.sql`). Adding a
`sender_id` column, or having the client tell the server who it is, would
have quietly undone that.

It isn't necessary. `auth.uid()` is available *inside the insert
transaction*: the server already had to know who was inserting in order to
authorise it against RLS. That knowledge is simply never persisted. An
`AFTER INSERT` trigger reads it, excludes that member, and stores nothing
(`supabase/migrations/0010_push_notifications.sql`). No new column, no new
row, no new fact retained.

What the server does now hold that it did not before: one Expo push token per
user, plus the literal notification strings to display. The strings are sent
by the recipient's own device rather than composed server-side, specifically
so the server does not end up holding "this user reads Portuguese" for every
user — it stays a relay that never composes and never has to know what any of
it means. The notification is contentless by construction ("You have a new
message"): the server only ever holds ciphertext, so it could not include the
message even if it wanted to, and keeping the text off a lock screen matters
independently.

The push token itself is a real addition to what a subpoena of the backend
would produce — it is a stable per-device identifier that Apple can link to a
device, and it is now correlated with a `user_id`. That is the price of
notifications working at all, and it is stated here rather than glossed over.
It is readable only by its owner (RLS, self-access only) and by the
`SECURITY DEFINER` trigger; the trigger has `EXECUTE` revoked from `public`,
`anon` and `authenticated`, following the lesson in "Hardening:
unauthenticated RPC access closed" above.

A gap found while writing this: `push_tokens` was created without a foreign
key, so it was the only table that would have *survived* an account deletion
— everything else cascades from `identities`. Fixed in
`supabase/migrations/0011_push_tokens_cascade.sql`.

### Replying to a message, and the quote that isn't there (2026-09-06)

Replies needed a way to say *which* message is being answered. Two decisions
were made deliberately, and both cost something.

**The reference travels inside the encryption, not in a column.** A
`reply_to` column on `messages` would have been trivial, and would have handed
the server the reply graph of every conversation -- which messages answer
which, and therefore the shape and rhythm of a conversation it currently
cannot see. The reference goes in the encrypted payload instead
(`app/src/messaging/payload.ts`), so the server keeps seeing opaque
ciphertext.

**A reply carries the quoted message's id, and not its text.** Every other
messenger copies the quoted text into the reply, which is why a WhatsApp quote
always renders. It also means a fragment of a message that has since expired
lives on inside a newer one, under a different timer -- a silent exception to
the promise this app makes about disappearing messages, invisible to the
person who sent the quoted message. So the quote is resolved locally at render
time, and shows "message unavailable" when the original is genuinely gone
(expired, manually deleted, or never received on this device).

The cost is real and worth stating: quoting is less reliable than users will
expect from other apps. The window is usually small -- it is the gap between
when the original expires and when the reply does, which equals the delay
between the two messages -- but a manual "delete now" on the original, or a
reinstall, empties every quote of it.

**Wire-format compatibility.** A message with no reply is still sent as bare
text, unchanged, so older builds read it exactly as before; anything that is
not marked JSON decodes as plain text, so newer builds read older messages.
The one gap: an older build receiving a *reply* renders the raw JSON, because
it predates the format. Unavoidable without having shipped the decoder first,
and it resolves once both devices update.

### Editing a sent message (2026-09-07)

An edit cannot rewrite the ciphertext already on the server, and the reason is
worth recording because it is not obvious. Every message is encrypted with a
Double Ratchet key used once and destroyed. If the stored ciphertext were
replaced, the recipient has either already spent that key reading the original
-- and could never read the replacement -- or has not read it yet, and would
find a message encrypted with a key that no longer matches anything. Editing
in place is impossible, not merely awkward. So an edit travels as an ordinary
new message carrying the id of the one it replaces
(`app/src/messaging/payload.ts`).

Three consequences, all deliberate:

**Edits are marked.** A message whose text can change silently is one nobody
can rely on having read: the other person could rewrite what they said, and
the reader would have no way to tell. The "edited" marker is what makes
editing safe to offer at all, and it is not optional.

**The timer does not restart.** The edit keeps the original message's
`expires_at`. Otherwise editing would be a way to keep a message alive
indefinitely, one edit at a time, quietly defeating disappearing messages.

**The original ciphertext stays on the server until it expires.** Deleting it
would be tidier, but the delete propagates to the recipient as a realtime
DELETE event and would remove the message that the edit had just corrected.
Leaving it costs one encrypted row the server cannot read, which the existing
TTL purge removes on schedule.

What editing does not do, and must not be presented as doing: unsend. If the
other person has already read the message, they have read it. The edit
corrects the record, not their memory.

### Voice messages (2026-09-08)

Voice messages do not change what the app protects. A recording is another
kind of content inside the same encrypted payload as text: same libsignal,
same channel, no sender column, opaque to the server. What they change is
everything around the content, and three decisions were made deliberately.

**The audio lives inside the message row, not in object storage.** The
obvious design puts the file in Supabase Storage and a reference in the
message. That would break the disappearing-message promise in a way nobody
would see: the TTL purge deletes *rows*, so the audio would outlive the
message that was supposed to take it away. Keeping it in the row means
deleting the row deletes the audio, with no new lifecycle code that has to
keep working. The cost is a hard 60-second cap -- about 180 KB at 24 kbps
mono, which Postgres carries without complaint where five minutes would not.
This does not scale: for a real user base the audio belongs in object storage
with a purge of its own, and that purge becomes a thing that must never fail
silently. Recorded here so the decision is revisited rather than inherited.

**The server holds a voice message for at most 24 hours**, however long the
sender's timer is. Until now, one number was doing two jobs: how long the
message lives on the devices, and how long the server waits to deliver it.
Audio makes the second expensive, so they are now separate -- the device
lifetime travels inside the ciphertext, and the server only learns when it may
throw its copy away. A message not collected within a day is lost, which is
the price of not letting audio accumulate; 24 hours rather than something
tighter because a message sent at 21:00 must survive until the recipient
wakes.

Deliberately not applied to text. There the same change would trade
reliability for a benefit the user can already choose more directly by
picking a shorter timer -- and a hidden 24-hour ceiling would silently
discard messages to anyone away for a couple of days.

**Recordings are constant-bitrate and payloads are padded to 64 KB
buckets.** Variable bitrate encodes louder passages larger, leaking the
rhythm of speech into the file size; there is published work recovering
phrases from exactly that in encrypted VoIP. Constant bitrate makes size a
function of duration alone, and the padding then blurs the duration into a
range. What padding does *not* hide is that a message is voice at all: tens
of kilobytes against a few hundred bytes for text. Hiding that would mean
padding text to the same size, which is not reasonable.

Two costs with no technical answer. Voice is biometric in a way text is not
-- an intercepted recording identifies the speaker to anyone who knows them.
And a recording captures what happens to be around: a television, a
conversation nearby, a station announcement. Neither changes what the app
defends against; both change the consequences if a device is compromised,
which was already out of scope.

**Playback writes decrypted audio to disk**, because playing a file requires
one. Every such file is deleted as soon as playback ends, when the screen is
left, and the whole directory is emptied at launch -- the last covering a
crash that skipped the first two. Without that, audio would sit in the app's
cache after the message it came from had expired.

### Signed prekey rotation (2026-09-09)

The signed prekey and the Kyber prekey were generated once, at registration,
and never changed. Their private halves therefore sat on the device
indefinitely, and a seized device exposed the session-establishment material
of *every* session anyone had ever started with that identity, back to the
beginning. Rotation turns "since forever" into "since the last rotation".

Every session in flight is at stake here, so the design is deliberately
lopsided towards keeping keys too long rather than too little:

**Rotation is additive.** A new pair is generated under new ids and stored
alongside the old ones; nothing is deleted at the moment of rotation. A peer
may have fetched the old bundle seconds earlier and be about to send with it.
Replacing rather than adding would make that message permanently unreadable,
silently, and only the sender would ever know it existed -- the same failure
as the one-time prekey regeneration bug of 2026-09-05, but worse, because a
signed prekey serves every new session rather than one. There is a Rust test
for exactly this: a message encrypted before rotation must still decrypt
after it.

**Ids are never reused.** A peer holding an old public key must never find a
different private key behind the same id.

**Old keys are kept 30 days, rotated every 2.** The keep window is far longer
than any plausible delay between fetching a bundle and sending, because being
wrong in that direction destroys messages while being wrong in the other
merely holds a key slightly longer than necessary. `prune_prekeys` refuses an
empty keep-list outright: an identity with no signed prekey is one nobody can
start a conversation with, and it would present as strangers being unable to
reach you rather than as any visible error.

**The server keeps only the current key.** It hands out what is current;
superseded public keys help nobody starting a conversation now. The private
halves live on the device for the grace period, which is where they are
needed.

Rotation runs at registration, is non-fatal, and skips silently on failure --
the previous key then stays in use, which is exactly the position before any
of this existed.

Still not rotated: the identity key itself. That is by design and matches
Signal -- it *is* the identity, and changing it is what the untrusted-identity
warning exists to report.

### Anyone could join any channel they knew the id of (found 2026-09-09)

Found while reading the membership rules before building groups, not by
anything going wrong.

`channel_members` had an insert policy of `member_id = auth.uid()`: it checked
that the row you were inserting was about *yourself*, and nothing at all about
the channel. Knowing a channel's id was therefore enough to join it and read
everything sent there from that moment on.

How bad it actually was: channel ids are random uuids, and `channel_members`
is only readable by members, so there was no way for a stranger to discover
one through the API. The realistic attacker was someone who had already been
in the channel -- they keep the id forever and could rejoin a conversation
they had left. Between two people that is close to harmless. For groups it
would have been fatal: removing someone would simply not have worked, and
neither would blocking them from a shared channel.

The fix removes the policy entirely, along with the one allowing anyone to
create channels. Nothing needed either: every membership row is written by
`create_direct_channel`, which is `SECURITY DEFINER` and bypasses RLS, and no
client code inserts into those tables. Joining a channel is now possible only
through a function that decides whether you may -- which is the only shape
that can support "the group owner adds members" without also meaning "anyone
can add themselves".

Verified by role-switching in SQL: creating a direct conversation still works,
and a deliberate attempt to insert oneself into someone else's channel is
refused by RLS.

Leaving stays self-service. Being able to remove yourself from a conversation
should never require anyone's permission.

### Voice message audio routing needed a native module (2026-09-10)

Three problems on real devices, two of which expo-audio cannot fix.

**Voice messages did not arrive until the conversation was reopened.** Not an
audio problem at all: Supabase Realtime drops oversized fields rather than
whole events -- past a size limit, only values of 64 bytes or less survive.
A voice message is 170-260 KB, so the event arrived with no ciphertext, and
only the catch-up fetch on opening a conversation ever saw the message. The
subscription now fetches the row by id when the payload comes back without
one.

**Recording through Bluetooth headphones did not work**, and **playback would
not move to the earpiece** when the phone was held to the ear. Both are
`AVAudioSession` category and option concerns, and expo-audio exposes only
`allowsRecording` -- known and open upstream (expo/expo#37512, #43086). So
this project now has a second local native module, `audio-session-expo`,
doing what the package will not: `.playAndRecord` with `.allowBluetooth`
while recording, so the microphone on AirPods is reachable at all; `.playback`
with `.allowBluetoothA2DP` while playing, for full-quality output; and
proximity-sensor routing to the receiver during playback, which iOS does not
do by itself.

The proximity sensor is turned off again as soon as playback ends. Left on, it
blanks the screen whenever anything approaches the phone, which is alarming in
an app that is not a phone call.

The module is loaded with `requireOptionalNativeModule`, so a build predating
it keeps working with plain audio rather than crashing -- the same guard, for
the same reason, as the app lock and push registration.


### What "sealed sender" here does and does not mean (corrected 2026-09-10)

This document claimed the backend "should never see the raw sender-recipient
mapping of an individual message (sealed sender)". That was wrong, and the
correction matters more than the original claim did.

**What is true:** `messages` has no sender column
(`supabase/migrations/0001_init.sql`). A dump of the database, a backup, or a
subpoena served on stored data does not say who sent which message. That is a
real property and it still holds.

**What is not true:** that the server cannot see it. Every insert is
authenticated, so `auth.uid()` identifies the sender at the moment the message
is written. Three features depend on exactly that and could not work
otherwise: the notification trigger excludes the sender
(`0010_push_notifications.sql`), blocked peers are filtered by it
(`0012_dont_notify_when_blocked.sql`), and channel creation checks it
(`0013`). A backend operator who wanted this could log it in a line of SQL.

So what this project has is **unlogged sender metadata**, not sealed sender.
The distinction is between *observing* and *retaining*, and it is worth
something — but far less than the name suggested, and nobody should decide
anything on the strength of the stronger claim.

Real sealed sender, as Signal implements it, encrypts the sender's identity so
the server cannot read it at all. libsignal has it
(`sealed_sender_encrypt`), and it requires a `SenderCertificate` signed by a
server key with an expiry — meaning server-side signing infrastructure,
certificate issuance and rotation. It is buildable here and has never been
built.

Found while working out how group messages would identify their sender, which
is the same question one layer down: a recipient in a group has to know which
key to decrypt with, and that is precisely what sealed sender is designed to
answer without telling the server.

### The complete list of retained metadata, and an IP log nobody knew about (2026-09-10)

Written after being asked, plainly, what metadata survives. Answering it
required reading the database rather than this document, and that turned up
something this document had wrong.

**Per account, for as long as it exists:** the user id, identity public key
and registration id; the prekeys; the push token and the notification strings
that go with it; the date -- not time -- of last use; and the block list,
which deliberately never expires because a block is a standing safety
preference rather than conversation. No phone number. **No email either --
until the account makes a recovery backup**, which attaches a derived
address; see "Recovery backups" below for exactly what that address is and
what it does and does not reveal.

**Per conversation, while it is alive:** which channels exist, their kind and
owner, who belongs to each, and for every message its channel, exact
timestamp, size and silent flag. Never content. All of it disappears once a
channel has no unexpired messages left (`purge-empty-stale-channels`), so the
social graph lasts as long as the conversation does rather than forever --
which is better than an earlier passage in this document implied.

**And, not ours: `auth.sessions` stores the client IP address and user
agent.** This document said the backend "sees" the IP. It does not merely see
it; Supabase's auth layer *retains* it, per session, indefinitely. On this
project's own instance that is 13 sessions and 4 distinct IP addresses going
back to 2026-07-25 -- a longer and more identifying record than anything the
app's own schema keeps, and it arrived with the authentication service rather
than by any decision made here.

It is worth stating what that means for everything else in this file: an IP
address is a stable identifier for a device and, with an ISP's cooperation, a
name. Any argument about hiding *who sent a message* is worth little while
that sits in a table. It is the strongest single reason why Tor (or any other
IP-hiding path) belongs ahead of sender-metadata work, not after it.

`auth.audit_log_entries`, which would hold more of the same, is empty.

Also found: `identities.display_name_ciphertext`, a column added at the start
and never written to -- zero rows populated. Dead schema, harmless, but it
should go rather than sit there implying a feature.


### IP addresses are now scrubbed every minute (2026-09-10)

Following directly from the finding above. `auth.sessions` held the client IP
and user agent for the life of each session -- 13 sessions and 4 addresses
going back to July on this instance.

Deleting those rows is not available: accounts are anonymous, so a device that
loses its session does not log back in, it creates a *new identity* and loses
its user id, contacts and conversations. The rows have to stay.

Blanking the two columns does not: both are nullable, neither takes part in
authentication -- the JWT and refresh token carry that -- and they exist for
"last seen from" screens this app does not have. A cron job now clears them
every minute, alongside deleting any audit-log entries older than an hour.
Verified on a real device: messaging continued to work and no identity was
recreated.

**What this does not achieve.** The auth layer rewrites the IP whenever a
token is refreshed, so an address exists for up to a minute before being
cleared. An operator watching in that window, or holding database backups,
still sees it. Reducing that to zero would mean patching a service this
project does not control. The honest claim is a permanent record reduced to a
transient one -- which matters a great deal against a subpoena for stored
data, and not at all against someone watching in real time.

And the network path itself is unchanged: whoever carries the traffic still
sees this device talking to this backend. Only the copy kept in the database
is gone. Tor remains the thing that would address the rest, and remains
unimplemented.

### Group conversations (2026-09-10)

Groups reuse the existing model rather than introducing a second one: channels
and channel_members were never limited to two people. What is new is
ownership, and one metadata cost that was chosen deliberately.

**How a group message is encrypted.** The Signal Protocol encrypts between two
devices, so a group message is encrypted once per member and the copies are
stored as a single row (`app/src/messaging/groupEnvelope.ts`). The work and
the bytes grow with the group, which is why membership is capped at ten
server-side: a minute of audio is about 180 KB, and fifty copies of that would
not be reasonable.

**The sender travels in the clear, and that is the cost.** A recipient has to
know whose session to decrypt with, and cannot learn it after decrypting.
There is no way around that without real sealed sender, which this project
does not have and which would not help while a stable IP accompanies every
request (see the two corrections above).

What makes it acceptable is that the record is not permanent. The sender lives
inside the message, and messages delete themselves on the timer the user
chose. So the server knows who spoke for as long as that message exists --
thirty seconds, an hour, a week -- rather than forever. The comparison is "an
instant" against "the lifetime of the message", not "never" against "always".

**What is not in the clear:** the member ids in the envelope are keys of a map,
and reveal nothing the server could not read in `channel_members` one table
over. Group names are encrypted and never reach the server at all.

**Membership is enforced server-side.** Only the owner adds or removes, in
`SECURITY DEFINER` functions, and blocking is respected in both directions --
being in a group with someone is no less contact than messaging them
privately. Client-side checks only hide buttons.

**What this cannot defend against:** a compromised server adding a member
silently. Signal built an entire private group system to prevent that; here
the answer is weaker and honest -- the member list is always visible, and
changes are shown in the conversation, so an addition is noticeable rather
than invisible. It does not prevent the attack.

**Joining shows no history**, and the app says so rather than presenting an
empty group. Earlier messages were encrypted to keys the new member does not
have; no amount of interface work changes that.


### Verifying a contact, and recovering from a changed key (2026-09-10)

Two gaps that this document had listed as open, and which had already cost
real messages: on 2026-09-05 a peer's identity key changed and the
conversation became permanently unreadable, with no route back short of
wiping the local store and losing every other conversation with it.

**Safety numbers.** A conversation now shows a 60-digit code derived from both
identity keys and both user ids, using Signal's own parameters. It is
identical on both phones and different for every pair, and it cannot be
produced without the private key behind it. Comparing it out of band -- in
person, by call, anything that is not this app -- is what turns
trust-on-first-use into verified trust: a server that substituted a key would
produce a different number, and the two people would see the mismatch. There
is a Rust test asserting both sides compute the same value, because a code
that differed by side would prove nothing while looking reassuring.

**Re-trusting after verification.** `forget_peer_identity` drops the stored
identity *and* the session for one peer, so their next message is accepted as
a first contact would be. Deliberately named for what it does: it forgets, it
does not trust. It accepts no particular key -- it only stops refusing, and
whoever writes next establishes the new identity.

Two decisions about how this is offered. The button appears only when a
conversation is actually blocked by a changed key, never as a standing option:
a permanent "trust anything" control is a reflex rather than a decision. And
it sits below the safety number rather than beside the warning, with wording
that says a changed key is exactly what impersonation would also look like --
so the number is on screen before the button can be pressed.

What it still cannot do is force anyone to actually compare. A user who taps
through is back to trust-on-first-use, and no interface fixes that.


### Recovery backups, and what they cost (2026-09-10)

Losing a phone used to mean losing the account. There was no export and no
migration, so a replacement device meant a new identity, a new id, and every
contact adding you again and re-verifying. This adds a way back, and it is
worth being precise about what was given up to get it.

**What the backup contains.** The identity key pair and the account's user
id. Not messages, not sessions, not prekey private halves. Keeping the
identity is the whole point -- a contact who compared safety numbers with you
last month does not have to do it again -- and excluding session state is not
an omission but a requirement: two devices advancing the same Double Ratchet
chain reuse message keys and destroy messages silently. That failure has
already been paid for twice in this project, and a backup is not the place to
risk it a third time. Everything but the identity is rebuilt from scratch,
which the protocol already does correctly on first contact.

**Where it lives.** In a file the user puts wherever they choose, handed over
through the system share sheet. Deliberately *not* on our server. A copy held
for every user would be the only thing in this app that never expires --
messages, channels and IP addresses all delete themselves -- and it would be
the single most valuable thing to steal, with unlimited time to attack it
offline. Keeping it out of the server means the risk lives where the user can
see and choose it: keep it in iCloud and you are trusting iCloud; keep it
only on the phone and losing the phone loses the backup.

**How it is protected.** A 12-word BIP-39 phrase, 128 bits from the system
CSPRNG, seals the file with AES-256-GCM under an HKDF-SHA256-derived key.
HKDF rather than a slow password hash is a deliberate choice tied to the
phrase being *generated* rather than chosen: there is no dictionary to run
against 128 random bits, so stretching buys nothing. If a user-chosen
passphrase is ever allowed, that must become Argon2id first -- the code says
so at the point where it would have to change. The format magic is passed as
AEAD associated data rather than merely prefixed, so an edited header fails
to open rather than opening as something else. Wrong phrase, truncated file
and tampered bytes all fail identically, so nothing tells an attacker which
guess was closest.

**The new cost, stated plainly: the account gains an email address.** Getting
back into the *same* account needs a credential that outlives the old device.
Rather than store a token that expires, the phrase derives an address and
password deterministically, so nothing has to be kept anywhere. The address
is a hash of the phrase on `@seixo.invalid`, a domain reserved by RFC 2606
that can never resolve, so no mail can be sent to it even by accident. It
reveals nothing about the person -- it is a hash of a secret the server never
sees -- but it is honest to record that `auth.users` now holds a permanent,
non-expiring per-account identifier for anyone who has made a backup, where
before it held none. The password carries the phrase's full entropy, so
guessing it is guessing the phrase.

**How that address gets confirmed, and why it is not a dashboard toggle.**
Checking the project's own auth configuration (the public
`/auth/v1/settings` endpoint, which needs only the publishable key) showed
`mailer_autoconfirm: false` -- email confirmation is on. An address on
`@seixo.invalid` can never receive the confirmation mail, and an unconfirmed
address does not sign in, so the feature as first written would have produced
backups that never restored. It failed safe rather than silently: the client
verifies the credentials were accepted before writing the file, and refused.

The obvious fix was to turn confirmation off for the whole project. Rejected:
that disables a protection everywhere to solve a problem in one place, and
leaves a setting whose reason nobody will remember in a year. Instead
`supabase/functions/link-recovery-credentials` attaches the pair with the
Admin API's `email_confirm`, so only these generated addresses are
auto-confirmed and the project setting stays as it is.

The cost of that choice, stated rather than buried: the derived password now
passes through our own Edge Function on its way to being hashed, which is one
more place that touches it. Going through `updateUser` would have sent it
straight to the auth service. The function therefore contains no logging at
all, and says so at the top -- Edge Function logs are retained, and this is
the one moment that secret exists outside the device. The function also
refuses any address that is not 32 hex characters on the reserved domain, so
it cannot be repurposed to attach a real email to an account.

**What a backup cannot do.** It cannot bring back messages: they were never
in it, and the ones sealed to the old device's prekeys are unreadable by
anyone, forever, because the private halves went with the phone. It cannot be
recovered without the phrase -- there is no reset, no support path, and no
copy on our side. And it cannot be used to restore onto a device that already
has an identity: that is refused rather than merged, because replacing an
identity while the sessions built on it stay in place fails later and far
away from the cause.

**Known weak points, not yet addressed.** The screen offers to copy the
phrase to the clipboard, which is a convenience with a real cost: other apps
can read the clipboard, and on iOS it may sync to other devices via
Handoff. It is offered because the alternative -- users photographing the
screen instead -- is worse, but it is the weakest link on that screen and
should probably grow a warning or a timed clear. And a 12-word phrase carries
only 4 checksum bits, so roughly one mistyped word in sixteen still passes
validation; the AEAD is what makes those fail safely, as a refusal to open
rather than as wrong plaintext.

**Verified, not assumed.** Twelve Rust tests cover this, including that a
restored identity produces the same safety number a contact had already
checked, that only the right phrase opens a blob, that a single flipped byte
is refused, and that the derived credentials come back identical from the
same phrase typed with different spacing and capitals.


### Sharing into Seixo, and the unread badge (2026-09-11)

Two iOS app extensions, added together because they need the same plumbing:
an App Group per build variant, extension identifiers, and credentials.

**Sharing a link or text into Seixo.** `expo-share-intent` 3.2.3, the last
release for Expo SDK 52, adds a share extension limited to web links and plain
text. The extension does not encrypt, send or see anything but the shared
item: it writes that item into the App Group's storage and opens the app
through `seixo://dataUrl=<key>`. The app reads it, clears the App Group copy
immediately (`resetShareIntent`), and keeps its own copy in memory only
(`store/pendingShareStore.ts`). So the shared item does touch disk -- in the
App Group, for the moment between the extension handing it over and the app
picking it up -- and it is honest to say so rather than claim it never does.

Nothing is sent on the person's behalf. The conversation list, which is only
reachable behind the app lock, the terms and an identity, opens "Share to...";
choosing a conversation places the text in its input box, and it leaves only
when they press send, encrypted like any other message. Leaving that screen in
any way discards the pending item.

**New surface: a URL scheme.** Any app or web page can now open `seixo://...`.
The only thing the app does with such a URL is look up a shared item by key in
its own App Group; a crafted URL can at most make it look for an item that is
not there. That holds only while the scheme has this single use -- any deep
link added later needs the same scrutiny, because this one is reachable by
anyone.

**The badge on the app icon.** A Notification Service Extension
(`app/ios-extensions/NotificationService.swift`, target added by
`expo-nse-plugin`) runs on the phone for each push, even with the app closed,
and adds one to a counter in the App Group. While the app is open,
`notifications/useAppBadge.ts` replaces that estimate with the real unread
total -- the same logic the conversation list shows -- through a small local
module, `shared-badge-expo`, which stores it for the extension to continue
from.

The server's part is a constant: every notification now carries
`mutableContent: true` (migration 0022), which is what lets iOS hand it to the
extension. It reveals nothing, being the same on every notification. The
rejected alternative was for the server to send the number itself, which would
need the app to report when each message is read -- a usage record this
project has declined to keep since 0016.

**Limits, stated plainly.** The extension counts notifications, not messages:
being added to a group counts too, and a message that produces no notification
(a silent one, or from someone blocked) does not. The count is corrected the
next time the app opens. The App Group holds only that number and, briefly,
a shared item.

**Verification status.** Both build variants resolve with distinct schemes and
App Groups, both extensions are registered with EAS for credentials, the new
module autolinks, and introspecting the config shows the app's entitlements
and Info.plist as intended (one App Group entry, no background modes added,
all permission strings present). What cannot be checked on Windows: Expo
refuses to generate the iOS project there, and Swift cannot be compiled, so
the first real test of the Xcode targets and of both Swift files is the build.

