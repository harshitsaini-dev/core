import { SIZES } from '@core/shared';
import { bytesToBase64Url, utf8ToBytes } from './encoding.js';

/**
 * Blind indexes: letting the server match without letting it read.
 *
 * For the handful of lookups that genuinely need to happen server-side — finding
 * an account by email, resolving a share token, spotting a duplicate URL — the
 * client sends `HMAC-SHA256(blindIndexKey, normalise(value))` alongside the
 * ciphertext. The server can run `WHERE blind_index = ?` and nothing else.
 *
 * Two properties are worth being explicit about, because they are the limits of
 * the technique:
 *
 *   1. Equality is all it supports. No ordering, no prefix matching, no ranges.
 *      Everything else in Core searches client-side, over decrypted data.
 *
 *   2. Equal values produce equal tags. The server therefore learns which rows
 *      share a value, even though it cannot learn the value. That is acceptable
 *      for the fields listed above and unacceptable for anything else — so the
 *      set of blind-indexed columns stays deliberately small.
 */

/**
 * Normalise before hashing so that trivially different spellings match.
 *
 * NFKC first, because "ﬁ" and "fi" must not produce different tags. Then case
 * folding and whitespace trimming.
 */
export function normalizeForIndex(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

/**
 * Email addresses are normalised more aggressively: the domain is
 * case-insensitive by the spec, and a stray leading `mailto:` is a common
 * paste artefact.
 */
export function normalizeEmail(email: string): string {
  return normalizeForIndex(email).replace(/^mailto:/, '');
}

/**
 * URLs are reduced to a host so that `https://github.com/login` and
 * `github.com` index alike. Anything unparseable falls back to plain
 * normalisation rather than throwing — a malformed URL is still a valid
 * thing for a user to have saved.
 */
export function normalizeUrl(url: string): string {
  const trimmed = normalizeForIndex(url);
  if (trimmed === '') return '';
  try {
    const parsed = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return trimmed;
  }
}

/**
 * Compute a blind index tag, truncated to 128 bits and base64url encoded.
 *
 * Truncation keeps the column small. 128 bits of a SHA-256 HMAC leaves
 * collision probability negligible at any vault size this project will ever
 * see, and a collision would only mean an extra candidate row to filter
 * client-side — not a disclosure.
 */
export async function blindIndex(key: CryptoKey, value: string): Promise<string> {
  const normalized = normalizeForIndex(value);
  const signature = await crypto.subtle.sign('HMAC', key, utf8ToBytes(normalized));
  return bytesToBase64Url(new Uint8Array(signature).subarray(0, SIZES.blindIndex));
}

/** Blind index for an email address. */
export async function blindIndexEmail(key: CryptoKey, email: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, utf8ToBytes(normalizeEmail(email)));
  return bytesToBase64Url(new Uint8Array(signature).subarray(0, SIZES.blindIndex));
}

/** Blind index for a URL, reduced to its host. */
export async function blindIndexUrl(key: CryptoKey, url: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', key, utf8ToBytes(normalizeUrl(url)));
  return bytesToBase64Url(new Uint8Array(signature).subarray(0, SIZES.blindIndex));
}
