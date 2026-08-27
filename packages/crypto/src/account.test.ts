import type { KdfParams } from '@core/shared';
import { describe, expect, it } from 'vitest';
import {
  createAccountKeys,
  deriveRecoveryVerifier,
  recoverAccountKeys,
  rewrapAccountKey,
  unwrapAccountKeys,
  wrapRecoveryKey,
} from './account.js';
import { DecryptionError, decryptString, encryptString } from './aes.js';
import { blindIndex } from './blind-index.js';
import { base64UrlToBytes } from './encoding.js';
import { deriveKeys } from './kdf.js';

const FAST: KdfParams = { algorithm: 'argon2id', memoryKiB: 512, iterations: 1, parallelism: 1 };
const SALT = new Uint8Array(16).fill(3);

async function masterKeyFor(password: string): Promise<CryptoKey> {
  return (await deriveKeys(password, SALT, FAST)).masterKey;
}

describe('createAccountKeys', () => {
  it('returns usable keys, a wrapped blob and a recovery string', async () => {
    const { keys, wrappedAccountKey, recoveryKey } = await createAccountKeys(
      await masterKeyFor('pw'),
    );

    expect(keys.dataKey.algorithm.name).toBe('AES-GCM');
    expect(keys.dataKey.extractable).toBe(false);
    expect(keys.blindIndexKey.algorithm.name).toBe('HMAC');
    expect(keys.blindIndexKey.extractable).toBe(false);
    expect(wrappedAccountKey.startsWith('v1.')).toBe(true);
    expect(base64UrlToBytes(recoveryKey)).toHaveLength(32);
  });

  it('generates a distinct account key every time', async () => {
    const master = await masterKeyFor('pw');
    const seen = new Set<string>();
    for (let i = 0; i < 20; i += 1) {
      seen.add((await createAccountKeys(master)).recoveryKey);
    }
    expect(seen.size).toBe(20);
  });

  it('never puts the account key in the clear in the wrapped blob', async () => {
    const { wrappedAccountKey, recoveryKey } = await createAccountKeys(await masterKeyFor('pw'));
    expect(wrappedAccountKey).not.toContain(recoveryKey);
  });
});

describe('unwrapAccountKeys', () => {
  it('recovers keys that decrypt data encrypted before the round trip', async () => {
    const master = await masterKeyFor('pw');
    const { keys, wrappedAccountKey } = await createAccountKeys(master);
    const envelope = await encryptString(keys.dataKey, 'my secret');

    const reopened = await unwrapAccountKeys(master, wrappedAccountKey);
    expect(await decryptString(reopened.dataKey, envelope)).toBe('my secret');
  });

  it('derives the same blind-index key across unlocks', async () => {
    const master = await masterKeyFor('pw');
    const { keys, wrappedAccountKey } = await createAccountKeys(master);
    const reopened = await unwrapAccountKeys(master, wrappedAccountKey);

    expect(await blindIndex(reopened.blindIndexKey, 'github.com')).toBe(
      await blindIndex(keys.blindIndexKey, 'github.com'),
    );
  });

  it('fails with a master key from the wrong password', async () => {
    const { wrappedAccountKey } = await createAccountKeys(await masterKeyFor('right'));
    await expect(unwrapAccountKeys(await masterKeyFor('wrong'), wrappedAccountKey)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('fails on a tampered wrapper', async () => {
    const master = await masterKeyFor('pw');
    const { wrappedAccountKey } = await createAccountKeys(master);
    const tampered = `${wrappedAccountKey.slice(0, -2)}${
      wrappedAccountKey.endsWith('A') ? 'B' : 'A'
    }`;
    await expect(unwrapAccountKeys(master, tampered)).rejects.toThrow();
  });
});

describe('master password change', () => {
  it('re-wraps the account key without touching any vault item', async () => {
    const oldMaster = await masterKeyFor('old password');
    const { keys, wrappedAccountKey } = await createAccountKeys(oldMaster);

    // Encrypt a small vault before the change.
    const items = await Promise.all(
      ['github', 'bank', 'DATABASE_URL=postgres://x'].map((value) =>
        encryptString(keys.dataKey, value),
      ),
    );

    const newMaster = await masterKeyFor('new password');
    const rewrapped = await rewrapAccountKey(oldMaster, newMaster, wrappedAccountKey);

    // The vault ciphertexts are byte-for-byte unchanged, and still readable.
    const reopened = await unwrapAccountKeys(newMaster, rewrapped);
    expect(await Promise.all(items.map((item) => decryptString(reopened.dataKey, item)))).toEqual([
      'github',
      'bank',
      'DATABASE_URL=postgres://x',
    ]);
  });

  it('leaves the old wrapper unusable with the new password', async () => {
    const oldMaster = await masterKeyFor('old');
    const newMaster = await masterKeyFor('new');
    const { wrappedAccountKey } = await createAccountKeys(oldMaster);
    await rewrapAccountKey(oldMaster, newMaster, wrappedAccountKey);

    await expect(unwrapAccountKeys(newMaster, wrappedAccountKey)).rejects.toThrow(DecryptionError);
  });

  it('refuses to re-wrap with the wrong old password', async () => {
    const { wrappedAccountKey } = await createAccountKeys(await masterKeyFor('old'));
    await expect(
      rewrapAccountKey(await masterKeyFor('guess'), await masterKeyFor('new'), wrappedAccountKey),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('emergency kit recovery', () => {
  it('opens the vault with the recovery key alone, no password involved', async () => {
    const { keys, recoveryKey } = await createAccountKeys(await masterKeyFor('forgotten'));
    const envelope = await encryptString(keys.dataKey, 'still readable');

    const recovered = await recoverAccountKeys(recoveryKey);
    expect(await decryptString(recovered.dataKey, envelope)).toBe('still readable');
  });

  it('tolerates the whitespace a printed kit tends to pick up', async () => {
    const { recoveryKey, keys } = await createAccountKeys(await masterKeyFor('pw'));
    const envelope = await encryptString(keys.dataKey, 'x');
    const recovered = await recoverAccountKeys(`  ${recoveryKey}\n`);
    expect(await decryptString(recovered.dataKey, envelope)).toBe('x');
  });

  it('re-establishes a password by wrapping the recovered key', async () => {
    const { keys, recoveryKey } = await createAccountKeys(await masterKeyFor('lost'));
    const envelope = await encryptString(keys.dataKey, 'preserved');

    const freshMaster = await masterKeyFor('chosen after recovery');
    const rewrapped = await wrapRecoveryKey(freshMaster, recoveryKey);

    const reopened = await unwrapAccountKeys(freshMaster, rewrapped);
    expect(await decryptString(reopened.dataKey, envelope)).toBe('preserved');
  });

  it('rejects a malformed recovery key', async () => {
    // Right alphabet, wrong length.
    await expect(recoverAccountKeys('too-short')).rejects.toThrow(TypeError);
    // Wrong alphabet entirely.
    await expect(recoverAccountKeys('not valid base64url!!')).rejects.toThrow(TypeError);
    // Valid base64url, but not 32 bytes.
    await expect(recoverAccountKeys('AAAA')).rejects.toThrow(RangeError);
  });
});

describe('deriveRecoveryVerifier', () => {
  it('is deterministic for the same recovery key', async () => {
    const { recoveryKey } = await createAccountKeys(await masterKeyFor('pw'));
    expect(await deriveRecoveryVerifier(recoveryKey)).toBe(
      await deriveRecoveryVerifier(recoveryKey),
    );
  });

  it('differs for different accounts', async () => {
    const master = await masterKeyFor('pw');
    const a = await createAccountKeys(master);
    const b = await createAccountKeys(master);
    expect(await deriveRecoveryVerifier(a.recoveryKey)).not.toBe(
      await deriveRecoveryVerifier(b.recoveryKey),
    );
  });

  it('is not the recovery key itself, so the server never holds the vault key', async () => {
    // The whole point: possession of the verifier proves possession of the
    // Account Key, but the verifier decrypts nothing.
    const { recoveryKey } = await createAccountKeys(await masterKeyFor('pw'));
    const verifier = await deriveRecoveryVerifier(recoveryKey);

    expect(verifier).not.toBe(recoveryKey);
    await expect(recoverAccountKeys(verifier)).resolves.toBeDefined();
    // Same length, so it decodes - but it opens a different, useless key.
    const wrong = await recoverAccountKeys(verifier);
    const real = await recoverAccountKeys(recoveryKey);
    const envelope = await encryptString(real.dataKey, 'secret');
    await expect(decryptString(wrong.dataKey, envelope)).rejects.toThrow();
  });

  it('rejects a malformed recovery key', async () => {
    await expect(deriveRecoveryVerifier('AAAA')).rejects.toThrow(RangeError);
  });
});
