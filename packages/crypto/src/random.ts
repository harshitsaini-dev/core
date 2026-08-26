/**
 * Randomness. Every unpredictable value in Core originates here.
 *
 * `Math.random` is never acceptable in this package, and the lint config has
 * no way to know that — so this module exists partly to give reviewers a single
 * place to check.
 */

import type { Bytes } from './encoding.js';

/** WebCrypto refuses a single request larger than this. */
const MAX_RANDOM_REQUEST = 65_536;

/** Cryptographically secure random bytes, of any length. */
export function randomBytes(length: number): Bytes {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError('randomBytes: length must be a non-negative integer');
  }
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < length; offset += MAX_RANDOM_REQUEST) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + MAX_RANDOM_REQUEST, length)));
  }
  return bytes;
}

/**
 * A uniformly distributed integer in `[0, maxExclusive)`.
 *
 * Rejection sampling rather than a modulo, because `random % n` is biased
 * towards the low end whenever `n` does not divide the range evenly. For a
 * password generator that bias is a genuine, if small, loss of entropy.
 */
export function randomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive < 1) {
    throw new RangeError('randomInt: maxExclusive must be a positive integer');
  }
  if (maxExclusive > 0x100000000) {
    throw new RangeError('randomInt: maxExclusive must be at most 2^32');
  }
  if (maxExclusive === 1) return 0;

  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buffer);
    const value = buffer[0] as number;
    if (value < limit) return value % maxExclusive;
  }
}

/** A uniformly random element of a non-empty array. */
export function randomChoice<T>(items: readonly T[]): T {
  if (items.length === 0) {
    throw new RangeError('randomChoice: array must not be empty');
  }
  return items[randomInt(items.length)] as T;
}

/**
 * Fisher-Yates shuffle, in place, using unbiased indices.
 *
 * Used by the password generator to place guaranteed character classes without
 * revealing their positions.
 */
export function shuffleInPlace<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}
