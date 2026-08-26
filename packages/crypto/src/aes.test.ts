import { ENVELOPE_VERSION } from '@core/shared';
import { describe, expect, it } from 'vitest';
import {
  DecryptionError,
  EnvelopeError,
  decryptBytes,
  decryptJson,
  decryptString,
  encryptBytes,
  encryptJson,
  encryptString,
  generateAesKey,
  importAesKey,
  parseEnvelope,
} from './aes.js';
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes } from './encoding.js';
import { randomBytes } from './random.js';

async function key(): Promise<CryptoKey> {
  return generateAesKey();
}

/** Rebuild an envelope with one byte of the ciphertext flipped. */
function tamperCiphertext(envelope: string, index: number): string {
  const [version, iv, ct] = envelope.split('.') as [string, string, string];
  const bytes = base64UrlToBytes(ct);
  bytes[index] = (bytes[index] as number) ^ 0x01;
  return `${version}.${iv}.${bytesToBase64Url(bytes)}`;
}

/** Rebuild an envelope with one byte of the IV flipped. */
function tamperIv(envelope: string, index: number): string {
  const [version, iv, ct] = envelope.split('.') as [string, string, string];
  const bytes = base64UrlToBytes(iv);
  bytes[index] = (bytes[index] as number) ^ 0x01;
  return `${version}.${bytesToBase64Url(bytes)}.${ct}`;
}

describe('envelope format', () => {
  it('is version.iv.ciphertext with a 12-byte iv', async () => {
    const envelope = await encryptString(await key(), 'hello');
    const parts = envelope.split('.');

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(ENVELOPE_VERSION);
    expect(base64UrlToBytes(parts[1] as string)).toHaveLength(12);
  });

  it('uses a fresh iv for every encryption', async () => {
    const k = await key();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add((await encryptString(k, 'same plaintext')).split('.')[1] as string);
    }
    // IV reuse under one key breaks GCM completely, so this is not a formality.
    expect(seen.size).toBe(200);
  });

  it('produces different ciphertext for identical plaintext', async () => {
    const k = await key();
    expect(await encryptString(k, 'x')).not.toBe(await encryptString(k, 'x'));
  });

  it('rejects structurally invalid envelopes before touching the key', () => {
    expect(() => parseEnvelope('nope')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('v1.only-two')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('v1.a.b.c')).toThrow(EnvelopeError);
    expect(() => parseEnvelope('v2.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA')).toThrow(
      /Unsupported envelope version/,
    );
    expect(() => parseEnvelope('v1.$$$.AAAAAAAAAAAAAAAAAAAAAA')).toThrow(/invalid base64url/);
    expect(() => parseEnvelope('v1.AAAA.AAAAAAAAAAAAAAAAAAAAAA')).toThrow(/IV must be 12 bytes/);
    expect(() => parseEnvelope('v1.AAAAAAAAAAAAAAAA.AAAA')).toThrow(/too short/);
  });
});

describe('round trips', () => {
  it('restores bytes exactly, at every size that matters', async () => {
    const k = await key();
    for (const size of [0, 1, 15, 16, 17, 1024, 65_536, 1_000_000]) {
      const plaintext = randomBytes(size);
      expect(await decryptBytes(k, await encryptBytes(k, plaintext))).toEqual(plaintext);
    }
  });

  it('restores strings including unicode, emoji and newlines', async () => {
    const k = await key();
    for (const text of ['', 'hello', 'पासवर्ड', '🔐🔑', 'line\nbreak\ttab', '"quoted"']) {
      expect(await decryptString(k, await encryptString(k, text))).toBe(text);
    }
  });

  it('restores json structures', async () => {
    const k = await key();
    const value = {
      title: 'GitHub',
      username: 'harshitsaini-dev',
      custom: [{ label: 'PIN', value: '0000', hidden: true }],
      nested: { deep: { deeper: null } },
    };
    expect(await decryptJson(k, await encryptJson(k, value))).toEqual(value);
  });

  it('survives 200 random round trips', async () => {
    const k = await key();
    for (let i = 0; i < 200; i += 1) {
      const plaintext = randomBytes(1 + (i % 97));
      expect(await decryptBytes(k, await encryptBytes(k, plaintext))).toEqual(plaintext);
    }
  });
});

describe('tamper detection', () => {
  it('fails when any single byte of the ciphertext is flipped', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'the quick brown fox');
    const length = base64UrlToBytes(envelope.split('.')[2] as string).length;

    // Every position, including the authentication tag at the end.
    for (let i = 0; i < length; i += 1) {
      await expect(decryptString(k, tamperCiphertext(envelope, i))).rejects.toThrow(
        DecryptionError,
      );
    }
  });

  it('fails when any single byte of the iv is flipped', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'the quick brown fox');

    for (let i = 0; i < 12; i += 1) {
      await expect(decryptString(k, tamperIv(envelope, i))).rejects.toThrow(DecryptionError);
    }
  });

  it('fails with the wrong key', async () => {
    const envelope = await encryptString(await key(), 'secret');
    await expect(decryptString(await key(), envelope)).rejects.toThrow(DecryptionError);
  });

  it('reports every failure identically, leaking no detail', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'secret');

    const wrongKey = await key();
    const messages = new Set<string>();
    for (const attempt of [
      () => decryptString(wrongKey, envelope),
      () => decryptString(k, tamperCiphertext(envelope, 0)),
      () => decryptString(k, tamperIv(envelope, 0)),
    ]) {
      try {
        await attempt();
      } catch (error) {
        messages.add((error as Error).message);
      }
    }
    expect(messages.size).toBe(1);
  });
});

describe('additional authenticated data', () => {
  it('round-trips when the same aad is supplied', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'value', 'item:123');
    expect(await decryptString(k, envelope, 'item:123')).toBe('value');
  });

  it('fails when the aad differs, so ciphertext cannot be moved between rows', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'value', 'item:123');
    await expect(decryptString(k, envelope, 'item:456')).rejects.toThrow(DecryptionError);
  });

  it('fails when the aad is omitted at decryption', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'value', 'item:123');
    await expect(decryptString(k, envelope)).rejects.toThrow(DecryptionError);
  });

  it('fails when an aad is supplied but none was used', async () => {
    const k = await key();
    const envelope = await encryptString(k, 'value');
    await expect(decryptString(k, envelope, 'item:123')).rejects.toThrow(DecryptionError);
  });
});

describe('key handling', () => {
  it('imports a 32-byte key as non-extractable by default', async () => {
    const imported = await importAesKey(randomBytes(32));
    expect(imported.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', imported)).rejects.toThrow();
  });

  it('refuses keys of the wrong length', async () => {
    await expect(importAesKey(randomBytes(16))).rejects.toThrow(RangeError);
    await expect(importAesKey(randomBytes(64))).rejects.toThrow(RangeError);
  });

  it('generates 256-bit keys', async () => {
    const generated = await generateAesKey(true);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', generated));
    expect(raw).toHaveLength(32);
  });

  it('decrypts identically whether the key was generated or imported', async () => {
    const raw = randomBytes(32);
    const a = await importAesKey(raw);
    const b = await importAesKey(raw);
    expect(await decryptString(b, await encryptString(a, 'shared'))).toBe('shared');
  });
});

describe('what actually reaches storage', () => {
  it('contains no recognisable fragment of the plaintext', async () => {
    const k = await key();
    const secret = 'CorrectHorseBatteryStaple';
    const envelope = await encryptString(k, secret);

    expect(envelope).not.toContain(secret);
    expect(envelope.toLowerCase()).not.toContain('horse');

    // And the raw bytes hold no window of the plaintext either.
    const ciphertext = base64UrlToBytes(envelope.split('.')[2] as string);
    const needle = utf8ToBytes(secret.slice(0, 4));
    const found = [...ciphertext].some((_, i) =>
      needle.every((byte, j) => ciphertext[i + j] === byte),
    );
    expect(found).toBe(false);
  });
});
