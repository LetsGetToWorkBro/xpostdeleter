/**
 * Crypto primitives, all Web Crypto — no dependencies.
 *
 * Two jobs:
 *   1. Seal OAuth tokens at rest (AES-256-GCM) so a KV or Durable Object dump
 *      is not a credential dump.
 *   2. Sign session cookies (HMAC-SHA-256) so the cookie is a bearer of an
 *      opaque id and nothing else.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ------------------------------- encodings ------------------------------- */

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomId(bytes = 24): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

/* --------------------------------- HMAC ---------------------------------- */

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

export async function sign(value: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return toBase64Url(sig);
}

export async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  const key = await hmacKey(secret);
  try {
    return await crypto.subtle.verify('HMAC', key, fromBase64Url(signature), encoder.encode(value));
  } catch {
    return false;
  }
}

/* ------------------------------ AES-256-GCM ------------------------------ */

let cachedKey: { material: string; key: CryptoKey } | null = null;

async function aesKey(base64Key: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.material === base64Key) return cachedKey.key;
  let raw: Uint8Array;
  try {
    raw = fromBase64Url(base64Key.replace(/\+/g, '-').replace(/\//g, '_'));
  } catch {
    throw new Error('TOKEN_ENCRYPTION_KEY is not valid base64.');
  }
  if (raw.length !== 32) {
    throw new Error(`TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${raw.length}). Use: openssl rand -base64 32`);
  }
  const key = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  cachedKey = { material: base64Key, key };
  return key;
}

/**
 * Encrypt an arbitrary JSON-serialisable value.
 * Output layout: base64url( iv[12] || ciphertext||tag ).
 */
export async function seal(value: unknown, base64Key: string): Promise<string> {
  const key = await aesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify(value));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return toBase64Url(out);
}

export async function unseal<T>(sealed: string, base64Key: string): Promise<T> {
  const key = await aesKey(base64Key);
  const raw = fromBase64Url(sealed);
  if (raw.length < 13) throw new Error('Sealed payload is malformed.');
  const iv = raw.slice(0, 12);
  const ct = raw.slice(12);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  return JSON.parse(decoder.decode(plaintext)) as T;
}

/* --------------------------------- PKCE ---------------------------------- */

export interface Pkce {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** RFC 7636 code verifier + S256 challenge. */
export async function createPkce(): Promise<Pkce> {
  const verifier = randomId(48); // 64 base64url chars, inside the 43–128 range
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  return { verifier, challenge: toBase64Url(digest), method: 'S256' };
}

/** Meta signs some callbacks; this verifies an `appsecret_proof`-style HMAC hex. */
export async function hmacHex(message: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(sig)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
