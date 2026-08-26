import { DEFAULT_KDF_PARAMS, SIZES } from '@core/shared';
import type { Encrypted, KdfParams } from '@core/shared';
import type { Bytes } from '@core/crypto';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptString,
  encryptString,
  importAesKey,
  utf8ToBytes,
} from '@core/crypto';

/**
 * Server-side key material, all derived from one secret.
 *
 * `AUTH_PEPPER` is the only server secret that matters, and it is used for
 * several unrelated purposes. Using it directly for all of them would mean a
 * weakness in one context could be leveraged against another, so every use gets
 * its own HKDF-derived sub-key with a distinct `info` string.
 *
 * None of these keys can decrypt vault data. That is the point: compromising
 * every one of them reveals no secret a user has stored.
 */

const INFO = {
  /** Locates a user row by email before authentication. */
  emailIndex: 'core.server.email-index.v1',
  /** Produces plausible salts for accounts that do not exist. */
  decoySalt: 'core.server.decoy-salt.v1',
  /** Hashes IP addresses for the audit log. */
  ipHash: 'core.server.ip-hash.v1',
  /** Hashes user agent strings for device fingerprinting. */
  uaHash: 'core.server.ua-hash.v1',
  /** Hashes session tokens before storage. */
  sessionToken: 'core.server.session-token.v1',
  /** Encrypts email addresses at rest. See the note on emailEncrypt. */
  emailAtRest: 'core.server.email-at-rest.v1',
} as const;

export type ServerKeyPurpose = keyof typeof INFO;

/** Parse and validate the configured pepper. */
export function parsePepper(raw: string | undefined): Bytes {
  if (!raw) {
    throw new Error(
      'AUTH_PEPPER is not set. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
    );
  }
  // Accept standard base64 as well as base64url — people paste both.
  const normalized = raw.trim().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const bytes = base64UrlToBytes(normalized);
  if (bytes.length < 32) {
    throw new Error(`AUTH_PEPPER must decode to at least 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Derive an HMAC key for one purpose.
 *
 * Derivation is cheap (HKDF over 32 bytes), and Workers give us no safe place
 * to cache a `CryptoKey` across requests anyway, so this is called per use.
 */
export async function deriveServerKey(
  pepper: Bytes,
  purpose: ServerKeyPurpose,
): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', pepper, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8ToBytes(INFO[purpose]),
    },
    hkdfKey,
    SIZES.key * 8,
  );
  return crypto.subtle.importKey('raw', new Uint8Array(bits), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

/** Tag a value under a purpose-specific key. Truncated to 128 bits. */
export async function serverTag(
  pepper: Bytes,
  purpose: ServerKeyPurpose,
  value: string,
): Promise<string> {
  const key = await deriveServerKey(pepper, purpose);
  const signature = await crypto.subtle.sign('HMAC', key, utf8ToBytes(value));
  return bytesToBase64Url(new Uint8Array(signature).subarray(0, SIZES.blindIndex));
}

/** Normalise an email the same way everywhere. Must match the client. */
export function normalizeEmail(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase().replace(/^mailto:/, '');
}

/** The lookup tag for an email address. */
export async function emailIndex(pepper: Bytes, email: string): Promise<string> {
  return serverTag(pepper, 'emailIndex', normalizeEmail(email));
}

/**
 * A salt for an account that does not exist.
 *
 * It has to be **deterministic**: an attacker who asks about the same address
 * twice and gets two different salts has learned the account is fake. Deriving
 * it from the address under a server key gives a value that is stable, looks
 * random, and cannot be distinguished from a real salt without the pepper.
 */
export async function decoySalt(pepper: Bytes, email: string): Promise<string> {
  const key = await deriveServerKey(pepper, 'decoySalt');
  const signature = await crypto.subtle.sign('HMAC', key, utf8ToBytes(normalizeEmail(email)));
  // Real salts are 16 bytes, so decoys must be too.
  return bytesToBase64Url(new Uint8Array(signature).subarray(0, SIZES.salt));
}

/**
 * Plausible KDF parameters for an account that does not exist.
 *
 * The salt being deterministic is not enough on its own. Real accounts store
 * parameters calibrated on the device that created them, so their iteration
 * count varies — while a decoy that always returned the defaults would stand
 * out immediately: constant defaults mean "no such account", calibrated values
 * mean "real account". That hands an attacker the enumeration oracle the decoy
 * salt was meant to close.
 *
 * So the decoy's iteration count is derived from the address too, landing in
 * the same range calibration produces. Memory is held at the default because
 * calibration never varies it.
 */
export async function decoyKdfParams(pepper: Bytes, email: string): Promise<KdfParams> {
  const key = await deriveServerKey(pepper, 'decoySalt');
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, utf8ToBytes(`params:${normalizeEmail(email)}`)),
  );

  // 3..20, matching what calibrateKdf lands on across real hardware.
  const MIN = 3;
  const SPREAD = 18;
  const iterations = MIN + ((signature[0] as number) % SPREAD);

  return { ...DEFAULT_KDF_PARAMS, iterations };
}

/**
 * Encrypt an email address for storage — under a **server** key, not the user's.
 *
 * This is the one piece of user data the operator can read, and pretending
 * otherwise would be dishonest. The server has to send magic links, login alerts
 * and new-device codes; an address encrypted under the user's Account Key would
 * be unreadable to it, and all of those features would simply not exist.
 *
 * So the choice is between "the operator can email you" and "the operator does
 * not know your address", and this project picks the former. What the encryption
 * still buys is real but narrower: a database dump on its own yields no
 * addresses, because the key lives in the Worker secret store rather than in D1.
 * An attacker needs both.
 *
 * Nothing else in the vault works this way. Titles, passwords, notes and `.env`
 * values are encrypted under keys the server never holds, and remain unreadable
 * even to someone holding the pepper.
 */
async function emailAtRestKey(pepper: Bytes): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey('raw', pepper, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8ToBytes(INFO.emailAtRest),
    },
    hkdfKey,
    SIZES.key * 8,
  );
  return importAesKey(new Uint8Array(bits) as Bytes);
}

const EMAIL_AAD = 'core.email.v1';

export async function emailEncrypt(pepper: Bytes, email: string): Promise<Encrypted> {
  return encryptString(await emailAtRestKey(pepper), normalizeEmail(email), EMAIL_AAD);
}

export async function emailDecrypt(pepper: Bytes, envelope: string): Promise<string> {
  return decryptString(await emailAtRestKey(pepper), envelope, EMAIL_AAD);
}

/** Hash an IP for the audit log. Never store the address itself. */
export async function hashIp(pepper: Bytes, ip: string): Promise<string> {
  return serverTag(pepper, 'ipHash', ip);
}

/** Hash a user agent string. It is a fingerprint, not a label. */
export async function hashUserAgent(pepper: Bytes, userAgent: string): Promise<string> {
  return serverTag(pepper, 'uaHash', userAgent);
}
