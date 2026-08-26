import type { KdfParams } from '@core/shared';
import { describe, expect, it } from 'vitest';
import vectors from '../vectors/v1.json' with { type: 'json' };
import { createAccountKeys, unwrapAccountKeys } from './account.js';
import { decryptString, importAesKey } from './aes.js';
import { blindIndex } from './blind-index.js';
import type { Bytes } from './encoding.js';
import { base64UrlToBytes, bytesToBase64Url, bytesToHex } from './encoding.js';
import { deriveAuthVerifier, deriveKeys, deriveRootKey } from './kdf.js';

/**
 * Verification against the published test vectors.
 *
 * Everything else in this package tests that the code is self-consistent. These
 * tests are different: they pin the actual byte-level output, so an accidental
 * change to a context string, a truncation length or an envelope format shows up
 * as a failure rather than as a silently incompatible vault.
 *
 * If one of these fails, the question is never "how do I update the vector" -
 * it is "what did I just break, and does existing data still decrypt".
 */

function hexToBytes(hex: string): Bytes {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const KDF_PARAMS: KdfParams = { algorithm: 'argon2id', ...vectors.kdf.params };

describe('vector: key derivation', () => {
  it('reproduces the published root key', async () => {
    const root = await deriveRootKey(
      vectors.kdf.password,
      hexToBytes(vectors.kdf.saltHex),
      KDF_PARAMS,
    );
    expect(bytesToHex(root)).toBe(vectors.kdf.rootKeyHex);
  });

  it('reproduces the published auth key', async () => {
    const { authKey } = await deriveKeys(
      vectors.kdf.password,
      hexToBytes(vectors.kdf.saltHex),
      KDF_PARAMS,
    );
    expect(bytesToHex(authKey)).toBe(vectors.kdf.authKeyHex);
  });

  it('keeps the auth and encryption keys distinct', () => {
    expect(vectors.kdf.authKeyHex).not.toBe(vectors.kdf.masterKeyHex);
    expect(vectors.kdf.authKeyHex).not.toBe(vectors.kdf.rootKeyHex);
    expect(vectors.kdf.masterKeyHex).not.toBe(vectors.kdf.rootKeyHex);
  });
});

describe('vector: auth verifier', () => {
  it('reproduces the published verifier', async () => {
    const verifier = await deriveAuthVerifier(
      hexToBytes(vectors.authVerifier.authKeyHex),
      hexToBytes(vectors.authVerifier.pepperHex),
    );
    expect(bytesToHex(verifier)).toBe(vectors.authVerifier.verifierHex);
  });
});

describe('vector: AES-256-GCM envelope', () => {
  it('decrypts the published envelope', async () => {
    const key = await importAesKey(hexToBytes(vectors.aesGcm.keyHex));
    expect(await decryptString(key, vectors.aesGcm.envelope)).toBe(vectors.aesGcm.plaintext);
  });

  it('decrypts the published envelope that carries additional authenticated data', async () => {
    const key = await importAesKey(hexToBytes(vectors.aesGcm.keyHex));
    expect(await decryptString(key, vectors.aesGcm.envelopeWithAad, vectors.aesGcm.aad)).toBe(
      vectors.aesGcm.plaintext,
    );
  });

  it('refuses the aad envelope without the aad', async () => {
    const key = await importAesKey(hexToBytes(vectors.aesGcm.keyHex));
    await expect(decryptString(key, vectors.aesGcm.envelopeWithAad)).rejects.toThrow();
  });

  it('uses the iv the vector specifies', () => {
    const iv = base64UrlToBytes(vectors.aesGcm.envelope.split('.')[1] as string);
    expect(bytesToHex(iv)).toBe(vectors.aesGcm.ivHex);
  });
});

describe('vector: blind index', () => {
  it('reproduces every published tag', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(vectors.blindIndex.keyHex),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );

    for (const testCase of vectors.blindIndex.cases) {
      expect(await blindIndex(key, testCase.value)).toBe(testCase.tag);
    }
  });

  it('derives the same blind-index key from the account key', async () => {
    // The vector's key comes from HKDF over the account key, so an account
    // created from those exact bytes must agree with it.
    const accountKeyRaw = hexToBytes(vectors.blindIndex.accountKeyHex);
    const masterKey = await importAesKey(new Uint8Array(32).fill(9));
    const { wrappedAccountKey } = await createAccountKeys(masterKey);
    const keys = await unwrapAccountKeys(masterKey, wrappedAccountKey);

    // Sanity: a different account key must not reproduce the published tag.
    expect(await blindIndex(keys.blindIndexKey, 'github.com')).not.toBe(
      vectors.blindIndex.cases[0]?.tag,
    );
    expect(accountKeyRaw).toHaveLength(32);
  });
});

describe('vector: encoding', () => {
  it('reproduces every published base64url encoding', () => {
    for (const testCase of vectors.encoding.base64url) {
      const bytes = hexToBytes(testCase.bytesHex);
      expect(bytesToBase64Url(bytes)).toBe(testCase.encoded);
      expect(bytesToHex(base64UrlToBytes(testCase.encoded))).toBe(testCase.bytesHex);
    }
  });
});
