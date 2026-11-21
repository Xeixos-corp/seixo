import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { supabase } from './supabaseClient';

/**
 * Single-use invites (supabase/migrations/0037_invites.sql).
 *
 * The code is made here and never sent to the server when the invite is
 * created: only its SHA-256 is. It travels in the link after the "#", which no
 * browser sends to any server, and reaches the server once, when the friend
 * redeems it. The code is also kept on this phone, so the invite can be
 * shared again from the list; the server could not give it back.
 */

/**
 * Where invite links point. A page there opens Seixo when it is installed
 * (universal link, see app.json associatedDomains and the site's
 * apple-app-site-association) and explains how to get it when it is not.
 */
export const INVITE_BASE_URL = 'https://xeixos-corp.github.io/c/#';

const CODES_KEY = 'invites.codes.v1';

/** Finds an invite code in a link or pasted text, or returns null. */
export function findInviteCode(text: string): string | null {
  const match = /(?:https:\/\/xeixos-corp\.github\.io\/c\/?#|seixo(?:-dev)?:\/\/invite\/?#?)([A-Za-z0-9_-]{16,64})/.exec(text);
  return match ? match[1] : null;
}

export function inviteLink(code: string): string {
  return INVITE_BASE_URL + code;
}

export type MyInvite = {
  id: string;
  createdAt: string;
  expiresAt: string;
  usedAt: string | null;
  /** Present only if this phone still has the code, for sharing it again. */
  code?: string;
};

/** Base64url without padding, written out rather than relying on btoa in Hermes. */
function base64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63];
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out;
}

async function readCodes(): Promise<Record<string, string>> {
  try {
    const raw = await AsyncStorage.getItem(CODES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeCodes(codes: Record<string, string>): Promise<void> {
  try {
    await AsyncStorage.setItem(CODES_KEY, JSON.stringify(codes));
  } catch {
    // Losing a code only means that invite cannot be shared again.
  }
}

/** Thrown when the account already has 20 open invites. */
export class TooManyInvitesError extends Error {}

/** Creates an invite and returns its code and link. */
export async function createInvite(): Promise<{ id: string; code: string; link: string }> {
  const code = base64Url(Crypto.getRandomBytes(16));
  const hashHex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, code, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
  const { data, error } = await supabase.rpc('create_invite', { code_hash: `\\x${hashHex}` });
  if (error) {
    if (error.message.includes('too many open invites')) throw new TooManyInvitesError();
    throw new Error(error.message);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { id: string } | undefined;
  if (!row?.id) throw new Error('invite not created');
  const codes = await readCodes();
  codes[row.id] = code;
  await writeCodes(codes);
  return { id: row.id, code, link: inviteLink(code) };
}

/** This account's invites, newest first, with the codes this phone kept. */
export async function listMyInvites(): Promise<MyInvite[]> {
  const { data, error } = await supabase
    .from('invites')
    .select('id, created_at, expires_at, used_at')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const codes = await readCodes();
  const rows = (data ?? []) as { id: string; created_at: string; expires_at: string; used_at: string | null }[];
  // Forget codes whose invites are gone from the server.
  const alive = new Set(rows.map((row) => row.id));
  const kept = Object.fromEntries(Object.entries(codes).filter(([id]) => alive.has(id)));
  if (Object.keys(kept).length !== Object.keys(codes).length) await writeCodes(kept);
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    code: row.used_at ? undefined : kept[row.id],
  }));
}

export async function cancelInvite(id: string): Promise<void> {
  const { error } = await supabase.from('invites').delete().eq('id', id);
  if (error) throw new Error(error.message);
  const codes = await readCodes();
  delete codes[id];
  await writeCodes(codes);
}

/** The reasons an invite can be refused, each with its own message. */
export type RedeemFailure = 'notValid' | 'own' | 'blocked';

export class RedeemError extends Error {
  constructor(readonly reason: RedeemFailure) {
    super(reason);
  }
}

/** Uses an invite and returns the inviter's account id. */
export async function redeemInvite(code: string): Promise<string> {
  const { data, error } = await supabase.rpc('redeem_invite', { code });
  if (error) {
    if (error.message.includes('own invite')) throw new RedeemError('own');
    if (error.message.includes('blocked')) throw new RedeemError('blocked');
    if (error.message.includes('invite not valid')) throw new RedeemError('notValid');
    throw new Error(error.message);
  }
  if (typeof data !== 'string') throw new RedeemError('notValid');
  return data;
}
