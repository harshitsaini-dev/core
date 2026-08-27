import { DEFAULT_KDF_PARAMS, KDF_CONTEXT, PBKDF2_FALLBACK_PARAMS } from '@core/shared';
import type { KdfParams } from '@core/shared';
import { describe, expect, it } from 'vitest';
import { bytesToHex, constantTimeEqual } from './encoding.js';
import {
  calibrateKdf,
  deriveAuthVerifier,
  deriveKeys,
  deriveRootKey,
  generateKdfSalt,
  isBelowCurrentPolicy,
} from './kdf.js';
import { randomBytes } from './random.js';

/**
 * Production parameters cost ~500ms by design, which is far too slow to run in
 * every test. These are deliberately weak and used only where the *shape* of
 * the derivation is under test rather than its cost.
 */
const FAST: KdfParams = { algorithm: 'argon2id', memoryKiB: 512, iterations: 1, parallelism: 1 };

const SALT = new Uint8Array(16).fill(7);

describe('deriveRootKey', () => {
  it('is deterministic for the same password, salt and params', async () => {
    const a = await deriveRootKey('correct horse battery staple', SALT, FAST);
    const b = await deriveRootKey('correct horse battery staple', SALT, FAST);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
    expect(a).toHaveLength(32);
  });

  it('changes completely with a different password', async () => {
    const a = await deriveRootKey('password-a', SALT, FAST);
    const b = await deriveRootKey('password-b', SALT, FAST);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('changes completely with a different salt', async () => {
    const a = await deriveRootKey('same', new Uint8Array(16).fill(1), FAST);
    const b = await deriveRootKey('same', new Uint8Array(16).fill(2), FAST);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('changes with different parameters, so params are part of the identity', async () => {
    const a = await deriveRootKey('same', SALT, FAST);
    const b = await deriveRootKey('same', SALT, { ...FAST, iterations: 2 });
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('handles unicode and very long passwords', async () => {
    const long = 'x'.repeat(4096);
    await expect(deriveRootKey(long, SALT, FAST)).resolves.toHaveLength(32);
    await expect(deriveRootKey('पासवर्ड🔐', SALT, FAST)).resolves.toHaveLength(32);
  });

  it('rejects a salt shorter than 8 bytes', async () => {
    await expect(deriveRootKey('pw', new Uint8Array(4), FAST)).rejects.toThrow(RangeError);
  });

  it('rejects nonsensical argon2 parameters', async () => {
    await expect(deriveRootKey('pw', SALT, { ...FAST, memoryKiB: 1 })).rejects.toThrow(RangeError);
    await expect(deriveRootKey('pw', SALT, { ...FAST, iterations: 0 })).rejects.toThrow(RangeError);
  });

  it('rejects a downgraded pbkdf2 iteration count', async () => {
    const weak: KdfParams = { ...PBKDF2_FALLBACK_PARAMS, iterations: 1000 };
    await expect(deriveRootKey('pw', SALT, weak)).rejects.toThrow(RangeError);
  });

  it('supports the pbkdf2 fallback path', async () => {
    const params: KdfParams = { ...PBKDF2_FALLBACK_PARAMS, iterations: 100_000 };
    const a = await deriveRootKey('pw', SALT, params);
    const b = await deriveRootKey('pw', SALT, params);
    expect(a).toHaveLength(32);
    expect(bytesToHex(a)).toBe(bytesToHex(b));
  });

  it('produces different output from argon2id and pbkdf2 for the same input', async () => {
    const argon = await deriveRootKey('pw', SALT, FAST);
    const pbkdf2 = await deriveRootKey('pw', SALT, {
      ...PBKDF2_FALLBACK_PARAMS,
      iterations: 100_000,
    });
    expect(constantTimeEqual(argon, pbkdf2)).toBe(false);
  });
});

describe('deriveKeys', () => {
  it('returns an auth key and a non-extractable master key', async () => {
    const { authKey, masterKey } = await deriveKeys('pw', SALT, FAST);

    expect(authKey).toHaveLength(32);
    expect(masterKey.extractable).toBe(false);
    expect(masterKey.algorithm.name).toBe('AES-GCM');
    expect(masterKey.usages.sort()).toEqual(['decrypt', 'encrypt']);
  });

  it('never lets the master key be exported', async () => {
    const { masterKey } = await deriveKeys('pw', SALT, FAST);
    await expect(crypto.subtle.exportKey('raw', masterKey)).rejects.toThrow();
  });

  it('separates the auth key from the encryption key', async () => {
    // Both come from the same root, so this asserts the HKDF domain separation
    // is actually applied - a bug that made them equal would hand the server
    // the key to the vault.
    const { authKey } = await deriveKeys('pw', SALT, FAST);
    const root = await deriveRootKey('pw', SALT, FAST);
    expect(constantTimeEqual(authKey, root)).toBe(false);
  });

  it('is deterministic', async () => {
    const a = await deriveKeys('pw', SALT, FAST);
    const b = await deriveKeys('pw', SALT, FAST);
    expect(bytesToHex(a.authKey)).toBe(bytesToHex(b.authKey));
  });

  it('produces a different auth key for a one-character password change', async () => {
    const a = await deriveKeys('password', SALT, FAST);
    const b = await deriveKeys('passworD', SALT, FAST);
    expect(constantTimeEqual(a.authKey, b.authKey)).toBe(false);
  });

  it('uses the documented context strings', () => {
    // Changing either of these silently locks every existing vault out, so the
    // values are pinned by test as well as by review.
    expect(KDF_CONTEXT.auth).toBe('core.auth.v1');
    expect(KDF_CONTEXT.encryption).toBe('core.enc.v1');
  });
});

describe('deriveAuthVerifier', () => {
  it('is deterministic for the same auth key and pepper', async () => {
    const authKey = randomBytes(32);
    const pepper = randomBytes(32);
    const a = await deriveAuthVerifier(authKey, pepper);
    const b = await deriveAuthVerifier(authKey, pepper);
    expect(constantTimeEqual(a, b)).toBe(true);
    expect(a).toHaveLength(32);
  });

  it('changes with the pepper, so a stolen database alone is not enough', async () => {
    const authKey = randomBytes(32);
    const a = await deriveAuthVerifier(authKey, randomBytes(32));
    const b = await deriveAuthVerifier(authKey, randomBytes(32));
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('changes with the auth key', async () => {
    const pepper = randomBytes(32);
    const a = await deriveAuthVerifier(randomBytes(32), pepper);
    const b = await deriveAuthVerifier(randomBytes(32), pepper);
    expect(constantTimeEqual(a, b)).toBe(false);
  });

  it('refuses a pepper that is too short to be useful', async () => {
    await expect(deriveAuthVerifier(randomBytes(32), randomBytes(8))).rejects.toThrow(RangeError);
  });
});

describe('generateKdfSalt', () => {
  it('returns 16 unpredictable bytes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const salt = generateKdfSalt();
      expect(salt).toHaveLength(16);
      seen.add(bytesToHex(salt));
    }
    expect(seen.size).toBe(100);
  });
});

describe('isBelowCurrentPolicy', () => {
  it('accepts the current defaults', () => {
    expect(isBelowCurrentPolicy(DEFAULT_KDF_PARAMS)).toBe(false);
  });

  it('flags reduced memory or iterations', () => {
    expect(isBelowCurrentPolicy({ ...DEFAULT_KDF_PARAMS, memoryKiB: 1024 })).toBe(true);
    expect(isBelowCurrentPolicy({ ...DEFAULT_KDF_PARAMS, iterations: 1 })).toBe(true);
  });

  it('flags a weakened pbkdf2 configuration', () => {
    expect(isBelowCurrentPolicy(PBKDF2_FALLBACK_PARAMS)).toBe(false);
    expect(isBelowCurrentPolicy({ ...PBKDF2_FALLBACK_PARAMS, iterations: 200_000 })).toBe(true);
  });
});

describe('calibrateKdf', () => {
  it('returns parameters and the measurement that justified them', async () => {
    // A low target keeps the test fast while still exercising the loop.
    const { params, measuredMs } = await calibrateKdf(1, 2);
    expect(params.algorithm).toBe('argon2id');
    expect(params.memoryKiB).toBe(DEFAULT_KDF_PARAMS.memoryKiB);
    expect(params.iterations).toBeGreaterThanOrEqual(1);
    expect(measuredMs).toBeGreaterThan(0);
  }, 30_000);

  it('stops at the iteration ceiling rather than looping forever', async () => {
    // An unreachable target forces the cap to be hit.
    const { params } = await calibrateKdf(10 ** 9, 2);
    expect(params.iterations).toBe(2);
  }, 30_000);
});

describe('production parameters', () => {
  it('cost enough to matter on this machine', async () => {
    const started = performance.now();
    await deriveRootKey('a realistic master password', SALT, DEFAULT_KDF_PARAMS);
    const elapsed = performance.now() - started;

    // Wide bounds on purpose: this asserts the defaults are neither trivially
    // cheap nor unusably slow, not that any particular machine is fast.
    expect(elapsed).toBeGreaterThan(50);
    expect(elapsed).toBeLessThan(5000);
  }, 30_000);
});
