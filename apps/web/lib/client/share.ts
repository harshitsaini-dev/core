'use client';

import { base64UrlToBytes, bytesToBase64Url } from '@core/crypto';
import type { Bytes } from '@core/crypto';

/**
 * A secret handed to somebody who has no account here.
 *
 * The link is `/s/<token>#<key>`. The token identifies a row; the key decrypts
 * it. A browser never sends the part after the `#`, so the server holds
 * ciphertext and an identifier for it and nothing that would open it — not in
 * the database, not in a request log, not in a CDN cache.
 *
 * A fresh 256-bit key per share, generated here and never stored. Deriving one
 * from the vault would mean every share ever made shares a fate with the vault
 * key, and the point of this is to hand over one thing.
 */

const SHARE_AAD = 'core.share-link.v1';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface SealedShare {
  /** Base64url `iv || ciphertext`, for the server to store. */
  readonly payload: string;
  /** Base64url key, for the fragment. Never sent anywhere. */
  readonly key: string;
}

export async function sealShare(text: string): Promise<SealedShare> {
  const raw = crypto.getRandomValues(new Uint8Array(32)) as Bytes;
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12)) as Bytes;

  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(SHARE_AAD) },
      key,
      encoder.encode(text),
    ),
  );

  const joined = new Uint8Array(iv.length + sealed.length);
  joined.set(iv, 0);
  joined.set(sealed, iv.length);

  return { payload: bytesToBase64Url(joined as Bytes), key: bytesToBase64Url(raw) };
}

/**
 * Open one, or fail.
 *
 * Returns null rather than throwing on anything wrong — a truncated link, a
 * key edited by hand, a payload the server garbled. There is one honest thing
 * to say to somebody holding a link that will not open, and it is the same
 * sentence in all of those cases.
 */
export async function openShare(payload: string, keyText: string): Promise<string | null> {
  try {
    const raw = base64UrlToBytes(keyText);
    const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);

    const joined = base64UrlToBytes(payload);
    if (joined.length <= 12) return null;

    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: joined.slice(0, 12),
        additionalData: encoder.encode(SHARE_AAD),
      },
      key,
      joined.slice(12),
    );

    return decoder.decode(plain);
  } catch {
    return null;
  }
}

/**
 * Read the key out of the address bar.
 *
 * `location.hash` and not a route parameter, deliberately, and worth saying
 * out loud because a later refactor that "tidies" this into the path would
 * hand the server every key ever generated without changing a single test.
 */
export function keyFromFragment(): string {
  if (typeof location === 'undefined') return '';
  return location.hash.startsWith('#') ? location.hash.slice(1) : '';
}
