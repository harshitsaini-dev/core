import { describe, expect, it } from 'vitest';
import { DecryptionError, generateAesKey } from './aes.js';
import { bytesToUtf8 } from './encoding.js';
import {
  createKeyPair,
  decryptFromSender,
  encryptForRecipient,
  importPublicKey,
  unwrapPrivateKey,
} from './sharing.js';

async function newUser() {
  const dataKey = await generateAesKey();
  const material = await createKeyPair(dataKey);
  return {
    dataKey,
    material,
    privateKey: await unwrapPrivateKey(dataKey, material.wrappedPrivateKey),
    publicKey: await importPublicKey(material.publicKey),
  };
}

describe('createKeyPair', () => {
  it('returns a public key in the clear and an encrypted private key', async () => {
    const dataKey = await generateAesKey();
    const { publicKey, wrappedPrivateKey } = await createKeyPair(dataKey);

    expect(publicKey.length).toBeGreaterThan(0);
    expect(wrappedPrivateKey.startsWith('v1.')).toBe(true);
  });

  it('generates a distinct pair per user', async () => {
    const dataKey = await generateAesKey();
    const a = await createKeyPair(dataKey);
    const b = await createKeyPair(dataKey);
    expect(a.publicKey).not.toBe(b.publicKey);
  });

  it('unwraps to a non-extractable private key', async () => {
    const dataKey = await generateAesKey();
    const material = await createKeyPair(dataKey);
    const privateKey = await unwrapPrivateKey(dataKey, material.wrappedPrivateKey);

    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('pkcs8', privateKey)).rejects.toThrow();
  });

  it('cannot be unwrapped with a different account key', async () => {
    const material = await createKeyPair(await generateAesKey());
    await expect(
      unwrapPrivateKey(await generateAesKey(), material.wrappedPrivateKey),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('sharing a secret', () => {
  it('lets the intended recipient read it', async () => {
    const alice = await newUser();
    const bob = await newUser();

    const envelope = await encryptForRecipient(alice.privateKey, bob.publicKey, 'DB_PASSWORD=hunter2');
    const opened = await decryptFromSender(bob.privateKey, alice.publicKey, envelope);

    expect(bytesToUtf8(opened)).toBe('DB_PASSWORD=hunter2');
  });

  it('is unreadable by a third party holding both public keys', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const eve = await newUser();

    const envelope = await encryptForRecipient(alice.privateKey, bob.publicKey, 'secret');

    await expect(decryptFromSender(eve.privateKey, alice.publicKey, envelope)).rejects.toThrow(
      DecryptionError,
    );
    await expect(decryptFromSender(eve.privateKey, bob.publicKey, envelope)).rejects.toThrow(
      DecryptionError,
    );
  });

  it('fails if the sender is misidentified', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const mallory = await newUser();

    const envelope = await encryptForRecipient(alice.privateKey, bob.publicKey, 'secret');
    await expect(
      decryptFromSender(bob.privateKey, mallory.publicKey, envelope),
    ).rejects.toThrow(DecryptionError);
  });

  it('produces different ciphertext each time for the same payload', async () => {
    const alice = await newUser();
    const bob = await newUser();

    const a = await encryptForRecipient(alice.privateKey, bob.publicKey, 'same');
    const b = await encryptForRecipient(alice.privateKey, bob.publicKey, 'same');
    expect(a).not.toBe(b);
  });

  it('handles empty and large payloads', async () => {
    const alice = await newUser();
    const bob = await newUser();

    for (const payload of ['', 'x'.repeat(100_000)]) {
      const envelope = await encryptForRecipient(alice.privateKey, bob.publicKey, payload);
      expect(bytesToUtf8(await decryptFromSender(bob.privateKey, alice.publicKey, envelope))).toBe(
        payload,
      );
    }
  });
});
