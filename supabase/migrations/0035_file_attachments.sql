-- Files (a PDF, a spreadsheet, a document) as well as photos: the attachments
-- bucket grows from 2 MiB to a little over 10 MiB per object.
--
-- Why the same bucket. A file is sealed on the phone exactly as a photo is
-- (packages/signal-native/rust/src/attachment.rs), stored under its message
-- id, and only its key travels inside the encrypted message. Everything 0027
-- built around that object applies unchanged: who may read and write it, the
-- two-minute upload window, the purge when the message goes, the day-long
-- ceiling, the orphan sweep. A second bucket would have meant a second copy of
-- all of it, and two copies drift.
--
-- Why 10 MiB. The cost is download traffic, paid once per recipient, not
-- storage, which empties within a day. The phone refuses anything larger
-- before sealing, with a reason. The limit below is 162 units of 64 KiB: the
-- largest sealed file is 161 units of padded content plus a 37-byte header
-- and tag, so the bucket is never the thing that refuses.
--
-- What this tells the server that it did not know: nothing about any file's
-- content, name or kind, which travel inside the encryption. The stored size
-- remains a 64 KiB band, as for photos; with files allowed the bands simply go
-- higher. A large band now says "probably a file rather than a photo", which
-- the server could already guess from the size of any object.
--
-- Unchanged on purpose: only application/octet-stream is accepted. The phone
-- seals before uploading, so anything with a real content type is by
-- definition something that was not encrypted.
--
-- Docs that describe this: docs/plans-deferred.md (the earlier decision to
-- exclude documents, and why it changed), the privacy policy and the FAQ.

update storage.buckets
set file_size_limit = 10616832  -- 162 * 65536
where id = 'attachments';
