import type { EncryptedEnvelope } from './index';

// supabase.messages only has one `ciphertext text` column (see
// supabase/migrations/0001_init.sql — deliberately no separate "type"
// column, so the server never sees anything beyond one opaque string).
// EncryptedEnvelope has two fields, so we pack both into that single
// column as compact JSON before writing, and unpack on read.

type WireEnvelope = { t: number; c: string };

export function encodeEnvelope(envelope: EncryptedEnvelope): string {
  const wire: WireEnvelope = { t: envelope.messageType, c: envelope.ciphertextBase64 };
  return JSON.stringify(wire);
}

export function decodeEnvelope(ciphertextColumn: string): EncryptedEnvelope {
  const wire = JSON.parse(ciphertextColumn) as WireEnvelope;
  return { messageType: wire.t, ciphertextBase64: wire.c };
}
