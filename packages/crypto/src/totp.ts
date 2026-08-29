import type { Bytes } from './encoding.js';

/**
 * Time-based one-time passwords (RFC 6238).
 *
 * Implemented rather than imported. It is about sixty lines of arithmetic over
 * an HMAC that WebCrypto already provides, and every library that does it also
 * brings a base32 decoder, a QR parser and a dependency tree — onto a page that
 * has to load before a phone can show anything.
 *
 * The default is SHA-1 with six digits and a thirty-second step. Not because
 * SHA-1 is a good hash, but because that is what every authenticator setup
 * screen assumes, and a generator that quietly disagreed would produce codes
 * that are wrong in a way nobody can debug from the outside.
 */

export interface TotpOptions {
  /** Code length. Six almost everywhere; some services use eight. */
  readonly digits?: number;
  /** Seconds per code. */
  readonly period?: number;
  readonly algorithm?: 'SHA-1' | 'SHA-256' | 'SHA-512';
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * Decode the secret as printed on a setup screen.
 *
 * Tolerant on purpose: spaces, lowercase and missing padding are all normal in
 * a value somebody copied off a page or typed from a photo, and rejecting them
 * would fail at the one moment the user cannot tell whether the secret or the
 * app is at fault.
 */
/**
 * Encode a secret the way a setup screen prints one.
 *
 * Needed because Google's export carries raw bytes while everything else in
 * this codebase — the item field, the URI parser, the generator — speaks
 * base32. Padded, since some services reject an unpadded secret and none
 * rejects a padded one.
 */
export function base32Encode(bytes: Bytes): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  while (output.length % 8 !== 0) output += '=';

  return output;
}

export function base32Decode(input: string): Bytes {
  const normalized = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();

  if (normalized === '' || /[^A-Z2-7]/.test(normalized)) {
    throw new TypeError('Invalid base32 secret');
  }

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;

  for (const character of normalized) {
    buffer = (buffer << 5) | BASE32_ALPHABET.indexOf(character);
    bits += 5;

    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }

  return new Uint8Array(bytes) as Bytes;
}

/**
 * The counter for a given moment, as eight big-endian bytes.
 *
 * Written through a DataView rather than bit-shifting, because the counter
 * exceeds 32 bits in the year 2242 and JavaScript's bitwise operators would
 * silently truncate it. Cheap correctness for a value that is otherwise fine
 * for two centuries and then quietly is not.
 */
function counterBytes(counter: number): Bytes {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setBigUint64(0, BigInt(counter), false);
  return new Uint8Array(buffer) as Bytes;
}

/** Generate the code for a counter value (RFC 4226). */
export async function hotp(
  secret: Bytes,
  counter: number,
  { digits = 6, algorithm = 'SHA-1' }: TotpOptions = {},
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    secret,
    { name: 'HMAC', hash: algorithm },
    false,
    ['sign'],
  );

  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBytes(counter)));

  // Dynamic truncation: the low nibble of the last byte picks where to read a
  // four-byte window, so the code depends on the whole digest rather than a
  // fixed slice of it.
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const binary =
    (((mac[offset] as number) & 0x7f) << 24) |
    (((mac[offset + 1] as number) & 0xff) << 16) |
    (((mac[offset + 2] as number) & 0xff) << 8) |
    ((mac[offset + 3] as number) & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** Generate the code for a moment in time. */
export async function totp(
  secret: string | Bytes,
  atMs: number = Date.now(),
  options: TotpOptions = {},
): Promise<string> {
  const { period = 30 } = options;
  const bytes = typeof secret === 'string' ? base32Decode(secret) : secret;

  return hotp(bytes, Math.floor(atMs / 1000 / period), options);
}

/** Seconds until the current code is replaced. */
export function secondsRemaining(atMs: number = Date.now(), period = 30): number {
  return period - (Math.floor(atMs / 1000) % period);
}

/**
 * Parse an `otpauth://` URI, as encoded in a setup QR code.
 *
 * Returns null rather than throwing. A pasted URI is user input and being
 * wrong is an ordinary outcome, not an exceptional one.
 */
export function parseOtpauth(uri: string): { secret: string; options: TotpOptions } | null {
  try {
    const parsed = new URL(uri.trim());
    if (parsed.protocol !== 'otpauth:') return null;
    if (parsed.host.toLowerCase() !== 'totp') return null;

    const secret = parsed.searchParams.get('secret');
    if (!secret) return null;

    // Validate now rather than at first use, so a bad secret is rejected on the
    // screen where it was entered.
    base32Decode(secret);

    const digits = Number(parsed.searchParams.get('digits') ?? 6);
    const period = Number(parsed.searchParams.get('period') ?? 30);
    const raw = (parsed.searchParams.get('algorithm') ?? 'SHA1').toUpperCase();

    const algorithm =
      raw === 'SHA256' ? 'SHA-256' : raw === 'SHA512' ? 'SHA-512' : ('SHA-1' as const);

    if (!Number.isInteger(digits) || digits < 6 || digits > 10) return null;
    if (!Number.isInteger(period) || period < 5 || period > 300) return null;

    return { secret, options: { digits, period, algorithm } };
  } catch {
    return null;
  }
}
