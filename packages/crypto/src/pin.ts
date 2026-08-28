import { SIZES } from '@core/shared';
import type { Bytes } from './encoding.js';
import { concatBytes, utf8ToBytes, wipe } from './encoding.js';
import { randomBytes } from './random.js';

/**
 * The quick-unlock PIN.
 *
 * This derives a key from four to eight digits, and it is worth being exact
 * about what that can and cannot be worth, because the honest answer is not
 * flattering and the design depends on admitting it.
 *
 * A six-digit PIN is a million possibilities. No iteration count fixes that:
 * the work factor multiplies the cost of a guess, and a million guesses stays a
 * million guesses. So this function is **not** where the security of quick
 * unlock comes from. It comes from two things outside it:
 *
 *   1. The PIN-wrapped Account Key is stored sealed under the device key — a
 *      non-extractable `CryptoKey` the browser will hand back but never reveal.
 *      Someone who copies the browser profile has a blob they cannot begin to
 *      attack, because the outer layer is not theirs to open.
 *
 *   2. A hard attempt limit, counted on disk before each try. Five wrong PINs
 *      and the stored material is destroyed; the vault then opens only with the
 *      master password, which is the thing that actually has entropy.
 *
 * The iteration count below is therefore not a security argument, it is a
 * speed bump: it makes an in-origin attacker's guesses cost something while the
 * counter is catching up with them. The counter is the control.
 */

/** Iterations for the PIN derivation. See the note above on what this buys. */
export const PIN_ITERATIONS = 600_000;

/** Domain separation, so a PIN key is never mistaken for a master key. */
const PIN_INFO = 'core.pin.v1';

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 8;

/** A fresh salt for a newly set PIN. */
export function generatePinSalt(): Bytes {
  return randomBytes(SIZES.salt);
}

/**
 * Whether a string could be a PIN at all.
 *
 * Digits only, and a length. Not a strength check — there is no such thing for
 * four digits, and pretending otherwise with a meter would be theatre. What
 * this rejects is a typo and an empty field.
 */
export function isValidPin(pin: string): boolean {
  return pin.length >= MIN_PIN_LENGTH && pin.length <= MAX_PIN_LENGTH && /^[0-9]+$/.test(pin);
}

/**
 * Derive the key that wraps the Account Key for quick unlock.
 *
 * Returned non-extractable, and used with the same `wrapAccountKey` /
 * `unwrapAccountKeys` pair the master password uses. That is deliberate: the
 * PIN path should be the audited path with a different key at the front, not a
 * second implementation of the same idea with its own mistakes.
 */
export async function derivePinKey(pin: string, salt: Bytes): Promise<CryptoKey> {
  const pinBytes = utf8ToBytes(pin);

  try {
    const material = await crypto.subtle.importKey('raw', pinBytes, 'PBKDF2', false, [
      'deriveBits',
    ]);

    const bits = await crypto.subtle.deriveBits(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        // The salt carries the domain string as well as the random part, so a
        // PIN key and any future key derived from the same digits land in
        // different places even given the same salt bytes.
        salt: concatBytes(salt, utf8ToBytes(PIN_INFO)),
        iterations: PIN_ITERATIONS,
      },
      material,
      SIZES.key * 8,
    );

    const raw = new Uint8Array(bits);
    try {
      return await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
        'encrypt',
        'decrypt',
      ]);
    } finally {
      wipe(raw);
    }
  } finally {
    wipe(pinBytes);
  }
}
