/**
 * Byte and string encoding helpers.
 *
 * These are deliberately dependency-free and isomorphic: they must behave
 * identically in a browser, in a Cloudflare Worker and in the test runner.
 */

const B64URL_ALPHABET_CHECK = /^[A-Za-z0-9_-]*$/;

/** UTF-8 text to bytes. */
export function utf8ToBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Bytes to UTF-8 text. Throws on invalid UTF-8. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Bytes to unpadded base64url. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on large payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Unpadded (or padded) base64url to bytes. Throws on invalid input. */
export function base64UrlToBytes(text: string): Uint8Array {
  const normalized = text.replace(/=+$/, '');
  if (!B64URL_ALPHABET_CHECK.test(normalized)) {
    throw new TypeError('Invalid base64url input');
  }
  const padded = normalized.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Bytes to lowercase hex. */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/** Concatenate byte arrays into one. */
export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Compare two byte arrays without leaking their contents through timing.
 *
 * Length is intentionally compared first and in the clear: a length difference
 * is not secret for any value this project compares, and folding it into the
 * loop would either truncate the comparison or leak through the loop count.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] as number) ^ (b[i] as number);
  }
  return diff === 0;
}

/**
 * Overwrite a buffer in place.
 *
 * This is best-effort. JavaScript engines may have copied the value elsewhere,
 * and it does nothing for immutable strings — which is exactly why keys are
 * held as non-extractable `CryptoKey` objects wherever possible.
 */
export function wipe(bytes: Uint8Array): void {
  bytes.fill(0);
}
