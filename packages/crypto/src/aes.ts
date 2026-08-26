import { ENVELOPE_VERSION, SIZES } from '@core/shared';
import type { Bytes } from './encoding.js';
import { base64UrlToBytes, bytesToBase64Url, bytesToUtf8, utf8ToBytes } from './encoding.js';
import { randomBytes } from './random.js';

/**
 * Authenticated encryption.
 *
 * Every stored value in Core is an envelope string:
 *
 *     v1.<base64url iv>.<base64url ciphertext+tag>
 *
 * The version prefix is what makes a future cipher migration possible without a
 * flag day: old records keep decrypting while new ones are written under a new
 * prefix.
 *
 * AES-256-GCM is used throughout. The authentication tag means a modified
 * ciphertext fails to decrypt rather than yielding garbage — which matters here,
 * because the party storing the ciphertext is explicitly untrusted and could
 * otherwise tamper with it undetected.
 */

/** Thrown whenever a ciphertext fails to decrypt, for any reason. */
export class DecryptionError extends Error {
  constructor(message = 'Decryption failed') {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Thrown when an envelope is structurally invalid before any crypto runs. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvelopeError';
  }
}

/** Import 32 raw bytes as an AES-GCM key. */
export async function importAesKey(
  raw: Bytes,
  extractable = false,
): Promise<CryptoKey> {
  if (raw.length !== SIZES.key) {
    throw new RangeError(`AES key must be exactly ${SIZES.key} bytes`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/** A new random AES-256-GCM key. */
export async function generateAesKey(extractable = false): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, [
    'encrypt',
    'decrypt',
  ]);
}

/**
 * Encrypt bytes into an envelope string.
 *
 * `aad` is optional additional authenticated data: it is not encrypted, but the
 * ciphertext will not decrypt unless the same value is supplied again. Use it to
 * bind a record to its identity, so that a hostile server cannot move a valid
 * ciphertext from one row to another.
 */
export async function encryptBytes(
  key: CryptoKey,
  plaintext: Bytes,
  aad?: string,
): Promise<string> {
  // A fresh IV per encryption. Reuse under the same key would be catastrophic
  // for GCM, so it is generated here and never accepted as a parameter.
  const iv = randomBytes(SIZES.iv);
  // Built imperatively: under exactOptionalPropertyTypes an `additionalData`
  // that is explicitly `undefined` is not the same as an absent one.
  const algorithm: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad !== undefined) {
    algorithm.additionalData = utf8ToBytes(aad);
  }

  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(algorithm, key, plaintext));
  return `${ENVELOPE_VERSION}.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

/** Encrypt a UTF-8 string. */
export async function encryptString(
  key: CryptoKey,
  plaintext: string,
  aad?: string,
): Promise<string> {
  return encryptBytes(key, utf8ToBytes(plaintext), aad);
}

/** Encrypt a JSON-serialisable value. */
export async function encryptJson(key: CryptoKey, value: unknown, aad?: string): Promise<string> {
  return encryptString(key, JSON.stringify(value), aad);
}

interface ParsedEnvelope {
  readonly version: string;
  readonly iv: Bytes;
  readonly ciphertext: Bytes;
}

/** Split and validate an envelope without attempting to decrypt it. */
export function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split('.');
  if (parts.length !== 3) {
    throw new EnvelopeError('Envelope must have exactly three dot-separated parts');
  }
  const [version, ivPart, ciphertextPart] = parts as [string, string, string];

  if (version !== ENVELOPE_VERSION) {
    throw new EnvelopeError(`Unsupported envelope version: ${version}`);
  }

  let iv: Bytes;
  let ciphertext: Bytes;
  try {
    iv = base64UrlToBytes(ivPart);
    ciphertext = base64UrlToBytes(ciphertextPart);
  } catch {
    throw new EnvelopeError('Envelope contains invalid base64url');
  }

  if (iv.length !== SIZES.iv) {
    throw new EnvelopeError(`IV must be ${SIZES.iv} bytes, got ${iv.length}`);
  }
  // Ciphertext always carries at least the 16-byte GCM tag.
  if (ciphertext.length < 16) {
    throw new EnvelopeError('Ciphertext is too short to contain an authentication tag');
  }

  return { version, iv, ciphertext };
}

/**
 * Decrypt an envelope back to bytes.
 *
 * Every failure — wrong key, tampered ciphertext, wrong AAD — surfaces as the
 * same `DecryptionError` with the same message. Distinguishing them would leak
 * information to anyone able to submit ciphertexts.
 */
export async function decryptBytes(
  key: CryptoKey,
  envelope: string,
  aad?: string,
): Promise<Bytes> {
  const { iv, ciphertext } = parseEnvelope(envelope);
  // Built imperatively: under exactOptionalPropertyTypes an `additionalData`
  // that is explicitly `undefined` is not the same as an absent one.
  const algorithm: AesGcmParams = { name: 'AES-GCM', iv };
  if (aad !== undefined) {
    algorithm.additionalData = utf8ToBytes(aad);
  }

  try {
    return new Uint8Array(await crypto.subtle.decrypt(algorithm, key, ciphertext));
  } catch {
    throw new DecryptionError();
  }
}

/** Decrypt an envelope to a UTF-8 string. */
export async function decryptString(
  key: CryptoKey,
  envelope: string,
  aad?: string,
): Promise<string> {
  const bytes = await decryptBytes(key, envelope, aad);
  try {
    return bytesToUtf8(bytes);
  } catch {
    // Valid tag but invalid UTF-8 should not happen; treat it as a failure
    // rather than returning replacement characters.
    throw new DecryptionError();
  }
}

/** Decrypt an envelope and parse it as JSON. */
export async function decryptJson<T>(
  key: CryptoKey,
  envelope: string,
  aad?: string,
): Promise<T> {
  const text = await decryptString(key, envelope, aad);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new DecryptionError();
  }
}
