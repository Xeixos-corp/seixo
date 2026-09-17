# Deferred plans

Work that is decided but not started. This file exists so the reasoning does
not have to be rebuilt from scratch weeks later; each plan says what it costs
and what was rejected, not only what to build.

---

# 1. Sending images

**Written 2026-09-17. Not started.** Agreed to come after the first App Store
release.

## Why the obvious approach does not work

Put the image inside the encrypted message, exactly as voice messages already
are. It is the smallest change and it preserves every existing guarantee: the
server gains no new surface, the existing purge keeps working, nothing new can
outlive a message.

It breaks on groups. A group message is **one row** carrying one encrypted copy
per member (`app/src/messaging/groupEnvelope.ts`), and Supabase's Postgres
Changes stream caps a record at **1024 KB** — past that it does not truncate
gracefully, it drops every field longer than 64 bytes, so the ciphertext would
simply not arrive over realtime. Measured on the live project: the largest
message today is 171 KB (a voice message), the average 5 KB.

A ten-person group would therefore need each copy under ~60 KB — a smeared
thumbnail. An app that sends a decent photo to one person and a smear to a
group is not acceptable, and a size limit that changes with the number of
people in the room is not explainable.

## The shape

Encrypt the image **once** with a random key, store that ciphertext as an
object, and put only the key inside each member's envelope. Ten members costs
one object and ten keys of about a hundred bytes. The message row stays small
and realtime keeps working.

### Before it leaves the phone

Decoded and re-encoded rather than sent as-is: JPEG, longest side 1600, which
produces a new file with no EXIF — no GPS, no camera model, no timestamp.
**Verify by reading the produced bytes**, not by trusting the library's
documentation.

Then padded up to the next 64 KB before encryption, so the stored size does not
describe the picture. Same reasoning as the `p` field in
`app/src/messaging/payload.ts`.

AES-256-GCM in the existing Rust crate — the same primitive and the same
randomness as the recovery backups.

### The object is named after the message id

This is the decision the whole plan rests on.

Naming the object `<message id>` lets the server delete it **without ever
knowing what it is**: a trigger on `messages` deletes the matching object, so
the purge that already runs every minute carries the blobs with it. No new
scheduled job to fail silently, no second retention story to keep true.

A random path would live only inside the ciphertext, which the server cannot
read — so it could never delete it, and encrypted files would outlive the
messages they belong to. That is precisely the sentence in the privacy policy
that must not become false.

A second, weekly sweep removes orphans: objects whose message never came to
exist because the send failed half way.

### Access

Private bucket. Insert and select allowed only to members of the channel the
message belongs to, checked the same way every other policy checks it. No
update or delete for anybody: deletion is the trigger's job.

### The cost to be honest about

`storage.objects.owner` records who uploaded. A one-to-one conversation
deliberately has no sender column on `messages`, so an object with an owner
reintroduces exactly that, and permanently.

Mitigation: a trigger that nulls the owner on insert. The upload request still
passes through the hosting layer's request log, which keeps the account id for
24 hours (see the privacy policy) — so the sender is knowable for a day, not
for the life of the message. That is the same exposure everything else already
has.

### Deliberately excluded

Video, animated GIFs, documents, and saving to the photo library.

The first three by the rule already agreed: only what the app can rebuild from
scratch. A JPEG can be decoded and re-encoded into a file with no history; a
PDF or a video is a container with layers nobody inspects, and what is hidden
inside travels encrypted but travels.

Saving to the library is the easiest way to put a message beyond its own timer.
Anyone determined can screenshot, which is at least a deliberate act.

## Order of work

1. **The purge first.** Bucket, policies, trigger, orphan sweep — written and
   proven with test objects *before* the app can send anything. The only order
   that guarantees no encrypted litter outlives its message.
2. Rust: `encrypt_attachment` / `decrypt_attachment`, with tests.
3. Native dependencies (picker, resizer) and **a development build** — nothing
   on the app side can be tested before one exists.
4. The app: pick, resize, encrypt, insert, upload, receive, download, decrypt,
   render, and every failure state. A tiny blurred preview travels inside the
   message so there is something to show before the object arrives.
5. Privacy policy, FAQ, and the "what the server knows" screen, which has to
   start counting attachments.
6. Production build, and App Privacy with the new photo-library permission.

## Estimate

Seven to nine hours of work, across three or four sessions, plus two builds and
one to two hours of testing on a real device. Realistic upper bound twelve to
fifteen hours.

The known risk that could take the upper half: React Native has no usable
`Blob`/`File`, so moving raw bytes to storage usually goes through base64,
which is slow and memory-hungry at a megabyte. Finding the right way to do that
is the kind of thing that costs an afternoon. The other two candidates are the
photo-library permission behaving differently from expectation, and EXIF not
actually being stripped by the chosen tool.

---

# 2. Forgetting conversations nobody uses

**Written 2026-09-17. Not started.** Bruno's idea, and a good one, once the
version that loses nothing is the one that gets built.

## What it is for

The server knows which accounts share a conversation, and now knows it for as
long as both accounts exist. That became more durable on purpose in migration
0026: the alternative was the bug it fixed, where a conversation in daily use
was deleted the first time its messages all expired.

So the pair outlives everything else. Two people who spoke once in March are
still visibly connected in December. The goal here is to let that expire too --
a month of silence and the server forgets they are connected.

## Why the naive version is worse than nothing

Deleting the channel deletes it from the phones as well. Reconciliation drops
any conversation the server no longer lists, and the **nickname lives on that
conversation** -- it is local, it is the only place it exists. So a month of
silence would cost the person the conversation *and* the name they gave
someone, leaving a 36-character id to find again from somewhere.

"The app deleted my contacts" is what that feels like, and it would be right.

## The version worth building

Delete the channel on the server; keep the conversation on the phone.

The phone already holds everything it needs: the peer's id and the name. A
dormant conversation stays in the list, empty, and the first message sent
creates a channel again -- `create_direct_channel` already reuses an existing
one rather than duplicating, so whoever writes first makes it and the other
side hears about it through the membership subscription it already runs.

The server forgets the pair after a month; the person notices nothing.

## The two hard parts

**Telling "the channel is gone" from "I left".** Reconciliation currently
removes any conversation missing from the server's list, and that is
deliberate: a conversation hidden while its membership row still exists is a
conversation the peer keeps writing into and the user never sees. The new
behaviour has to apply to the first case and not the second, and getting it
wrong produces either ghost conversations or silently deleted ones.

**Rejoining the two sides.** Both phones hold a dormant conversation with the
same person but the *old* channel id. When a new channel appears, each side has
to recognise it as that person's conversation and adopt it, rather than adding
a second entry for somebody already in the list. Two devices are needed to test
it, and a wrong answer here shows up as duplicate conversations.

## What it costs in metadata, stated plainly

Knowing a channel has been empty for a month needs a date on the channel,
written when a message arrives. That is a fact about people which outlives the
messages: "these two last exchanged something on 3 October".

Keep it to a **date, never a time**, the same restraint as `last_active_on` in
0016. The trade is then: the server learns a coarse last-activity day, and in
exchange forgets the pair entirely a month later, instead of remembering it for
as long as both accounts live. Worth it, but it is a trade and not a pure win.

## Open questions for whoever builds it

- **Groups too, or only one-to-one?** Deleting a quiet group removes it for
  everyone and the owner has to rebuild the membership. Starting with direct
  conversations only is the cautious answer.
- **Is a month right?** People go months without writing to someone. Long
  enough that nothing is lost by accident matters more than shortening the
  window.
