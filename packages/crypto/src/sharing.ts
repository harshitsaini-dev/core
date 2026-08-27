import { SIZES } from '@core/shared';
import type { Encrypted } from '@core/shared';
import { decryptBytes, encryptBytes, importAesKey } from './aes.js';
import type { Bytes } from './encoding.js';
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes, wipe } from './encoding.js';

/**
 * Asymmetric key material, for sharing a secret with someone else.
 *
 * Not used by any v1 feature. It exists now because the key pair has to be
 * generated at signup — retrofitting one onto existing accounts later would
 * mean a migration that touches every user. Generating 32 bytes of unused key
 * material today is far cheaper than that.
 *
 *   sender:    ECDH(myPrivate, theirPublic) -> HKDF -> AES key -> ciphertext
 *   recipient: ECDH(myPrivate, theirPublic) -> HKDF -> same AES key
 *
 * The private key is stored wrapped by the Account Key, so the server holds
 * only the public half.
 */

const PRIVATE_KEY_AAD = 'core.private-key.v1';
const SHARE_INFO = 'core.share.v1';

export interface KeyPairMaterial {
  /** SPKI, base64url. Public — stored in the clear. */
  readonly publicKey: string;
  /** PKCS#8, encrypted under the Account Key. */
  readonly wrappedPrivateKey: Encrypted;
}

/** Generate an ECDH P-256 key pair and wrap the private half. */
export async function createKeyPair(dataKey: CryptoKey): Promise<KeyPairMaterial> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ]);

  const [spki, pkcs8] = await Promise.all([
    crypto.subtle.exportKey('spki', pair.publicKey),
    crypto.subtle.exportKey('pkcs8', pair.privateKey),
  ]);

  const privateBytes = new Uint8Array(pkcs8);
  try {
    return {
      publicKey: bytesToBase64Url(new Uint8Array(spki)),
      wrappedPrivateKey: await encryptBytes(dataKey, privateBytes, PRIVATE_KEY_AAD),
    };
  } finally {
    wipe(privateBytes);
  }
}

/** Import a stored public key. */
export async function importPublicKey(publicKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'spki',
    base64UrlToBytes(publicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

/** Unwrap a stored private key using the Account Key. */
export async function unwrapPrivateKey(
  dataKey: CryptoKey,
  wrappedPrivateKey: string,
): Promise<CryptoKey> {
  const pkcs8 = await decryptBytes(dataKey, wrappedPrivateKey, PRIVATE_KEY_AAD);
  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      pkcs8,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
  } finally {
    wipe(pkcs8);
  }
}

/**
 * Derive the shared AES key for a sender/recipient pair.
 *
 * The raw ECDH output is not used directly as a key: it is not uniformly
 * distributed, so it goes through HKDF-Extract-and-Expand first.
 */
async function deriveSharedKey(privateKey: CryptoKey, publicKey: CryptoKey): Promise<CryptoKey> {
  const sharedBits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: publicKey },
    privateKey,
    256,
  );
  const shared = new Uint8Array(sharedBits);

  try {
    const hkdfKey = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']);
    const keyBits = await crypto.subtle.deriveBits(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: utf8ToBytes(SHARE_INFO),
      },
      hkdfKey,
      SIZES.key * 8,
    );
    const keyBytes = new Uint8Array(keyBits);
    try {
      return await importAesKey(keyBytes);
    } finally {
      wipe(keyBytes);
    }
  } finally {
    wipe(shared);
  }
}

/** Encrypt a payload so that only the holder of `recipientPublicKey` can read it. */
export async function encryptForRecipient(
  senderPrivateKey: CryptoKey,
  recipientPublicKey: CryptoKey,
  plaintext: string,
): Promise<Encrypted> {
  const key = await deriveSharedKey(senderPrivateKey, recipientPublicKey);
  return encryptBytes(key, utf8ToBytes(plaintext), SHARE_INFO);
}

/** Decrypt a payload addressed to us. */
export async function decryptFromSender(
  recipientPrivateKey: CryptoKey,
  senderPublicKey: CryptoKey,
  envelope: string,
): Promise<Bytes> {
  const key = await deriveSharedKey(recipientPrivateKey, senderPublicKey);
  return decryptBytes(key, envelope, SHARE_INFO);
}
