import { describe, expect, it } from 'vitest';
import { unwrapAccountKeys } from './account';
import { encryptBytes, decryptBytes } from './aes';
import { bytesToBase64Url } from './encoding';
import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, derivePinKey, generatePinSalt, isValidPin } from './pin';
import { randomBytes } from './random';

/**
 * The quick-unlock PIN.
 *
 * These tests do not claim a PIN is strong; four digits are four digits, and no
 * test here can change that. What they hold is the part that is a design
 * decision rather than a fact of arithmetic: the same PIN and salt reach the
 * same key, a different PIN never does, and the key produced is the same shape
 * as a master key so the PIN path can reuse the audited wrapping rather than
 * grow a second one.
 */

describe('isValidPin', () => {
  it('accepts digits within the range', () => {
    expect(isValidPin('0000')).toBe(true);
    expect(isValidPin('12345678')).toBe(true);
  });

  it('rejects anything shorter or longer', () => {
    expect(isValidPin('1'.repeat(MIN_PIN_LENGTH - 1))).toBe(false);
    expect(isValidPin('1'.repeat(MAX_PIN_LENGTH + 1))).toBe(false);
  });

  it('rejects anything that is not a digit', () => {
    // Not a strength rule. A PIN pad produces digits, and a field that quietly
    // accepted "hunter2" would store it as if it were one.
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('12 4')).toBe(false);
    expect(isValidPin('')).toBe(false);
  });
});

describe('derivePinKey', () => {
  it('is deterministic for one PIN and salt', async () => {
    const salt = generatePinSalt();
    const secret = randomBytes(32);

    const sealed = await encryptBytes(await derivePinKey('4821', salt), secret, 'test');
    const opened = await decryptBytes(await derivePinKey('4821', salt), sealed, 'test');

    expect(bytesToBase64Url(opened)).toBe(bytesToBase64Url(secret));
  });

  it('a different PIN does not open it', async () => {
    const salt = generatePinSalt();
    const sealed = await encryptBytes(await derivePinKey('4821', salt), randomBytes(32), 'test');

    await expect(decryptBytes(await derivePinKey('4822', salt), sealed, 'test')).rejects.toThrow();
  });

  it('the same PIN under a different salt does not open it', async () => {
    // Why the salt exists: two people choosing 1234 must not share a key, and
    // re-setting the same PIN must not reproduce the old one.
    const sealed = await encryptBytes(
      await derivePinKey('4821', generatePinSalt()),
      randomBytes(32),
      'test',
    );

    await expect(
      decryptBytes(await derivePinKey('4821', generatePinSalt()), sealed, 'test'),
    ).rejects.toThrow();
  });

  it('produces a key that is not extractable', async () => {
    // The PIN itself is guessable, so the key it derives must at least not be
    // copyable out of the page by anything that manages to run in it.
    const key = await derivePinKey('4821', generatePinSalt());

    expect(key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow();
  });

  it('wraps an Account Key the ordinary unwrap can open', async () => {
    // The point of the whole design: the PIN path is the audited path with a
    // different key at the front, not a second implementation of it.
    const salt = generatePinSalt();
    const accountKey = randomBytes(32);

    const wrapped = await encryptBytes(
      await derivePinKey('4821', salt),
      accountKey,
      'core.account-key.v1',
    );

    const keys = await unwrapAccountKeys(await derivePinKey('4821', salt), wrapped);
    expect(keys.dataKey).toBeDefined();
    expect(keys.blindIndexKey).toBeDefined();
  });
});
