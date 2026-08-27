/**
 * Regenerate packages/crypto/vectors/v1.json.
 *
 *   node packages/crypto/scripts/generate-vectors.mjs
 *
 * The committed vectors are what let somebody else implement a compatible
 * client - or check that ours does what it claims - without trusting this
 * repository's own test suite.
 *
 * Every input here is fixed. If regenerating produces a diff, either a
 * deliberate format change was made or something broke; there is no third
 * possibility. Never commit a diff you cannot explain.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argon2id } from 'hash-wasm';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../vectors/v1.json');

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes) => Buffer.from(bytes).toString('hex');
const utf8 = (text) => new TextEncoder().encode(text);

/** Fixed inputs. Do not change these; add new cases instead. */
const PASSWORD = 'correct horse battery staple';
const SALT = new Uint8Array(16).fill(0x2a);
const PEPPER = new Uint8Array(32).fill(0x5c);
const IV = new Uint8Array(12).fill(0x11);
const ACCOUNT_KEY = new Uint8Array(32).fill(0x3d);
const PLAINTEXT = 'DATABASE_URL=postgres://user:pass@localhost:5432/core';

const KDF_PARAMS = { memoryKiB: 512, iterations: 2, parallelism: 1 };

async function expand(root, info, length = 32) {
  const key = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: utf8(info) },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

const root = await argon2id({
  password: PASSWORD,
  salt: SALT,
  parallelism: KDF_PARAMS.parallelism,
  iterations: KDF_PARAMS.iterations,
  memorySize: KDF_PARAMS.memoryKiB,
  hashLength: 32,
  outputType: 'binary',
});

const authKey = await expand(root, 'core.auth.v1');
const masterKeyBytes = await expand(root, 'core.enc.v1');

const pepperKey = await crypto.subtle.importKey(
  'raw',
  PEPPER,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);
const verifier = new Uint8Array(await crypto.subtle.sign('HMAC', pepperKey, authKey));

// AES vectors use a fixed IV so the ciphertext is reproducible. Production code
// never accepts an IV parameter, precisely so this cannot happen by accident.
const aesKey = await crypto.subtle.importKey('raw', ACCOUNT_KEY, { name: 'AES-GCM' }, false, [
  'encrypt',
  'decrypt',
]);
const ciphertext = new Uint8Array(
  await crypto.subtle.encrypt({ name: 'AES-GCM', iv: IV }, aesKey, utf8(PLAINTEXT)),
);
const ciphertextWithAad = new Uint8Array(
  await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: IV, additionalData: utf8('core.account-key.v1') },
    aesKey,
    utf8(PLAINTEXT),
  ),
);

const blindIndexKeyBytes = await expand(ACCOUNT_KEY, 'core.blind-index.v1');
const blindIndexKey = await crypto.subtle.importKey(
  'raw',
  blindIndexKeyBytes,
  { name: 'HMAC', hash: 'SHA-256' },
  false,
  ['sign'],
);

async function tag(value) {
  const signature = await crypto.subtle.sign('HMAC', blindIndexKey, utf8(value));
  return b64url(new Uint8Array(signature).subarray(0, 16));
}

const vectors = {
  $comment:
    'Core cryptography test vectors, envelope version v1. Inputs are fixed; regenerate with packages/crypto/scripts/generate-vectors.mjs.',
  version: 'v1',
  kdf: {
    algorithm: 'argon2id',
    note: 'Weak parameters on purpose so that verification is fast. Production uses m=65536, t=3, p=1.',
    params: KDF_PARAMS,
    password: PASSWORD,
    saltHex: hex(SALT),
    rootKeyHex: hex(root),
    authKeyHex: hex(authKey),
    masterKeyHex: hex(masterKeyBytes),
    contexts: { auth: 'core.auth.v1', encryption: 'core.enc.v1' },
  },
  authVerifier: {
    algorithm: 'HMAC-SHA256',
    pepperHex: hex(PEPPER),
    authKeyHex: hex(authKey),
    verifierHex: hex(verifier),
  },
  aesGcm: {
    algorithm: 'AES-256-GCM',
    keyHex: hex(ACCOUNT_KEY),
    ivHex: hex(IV),
    plaintext: PLAINTEXT,
    envelope: `v1.${b64url(IV)}.${b64url(ciphertext)}`,
    envelopeWithAad: `v1.${b64url(IV)}.${b64url(ciphertextWithAad)}`,
    aad: 'core.account-key.v1',
  },
  blindIndex: {
    algorithm: 'HMAC-SHA256 truncated to 128 bits',
    accountKeyHex: hex(ACCOUNT_KEY),
    info: 'core.blind-index.v1',
    keyHex: hex(blindIndexKeyBytes),
    cases: [
      { value: 'github.com', tag: await tag('github.com') },
      { value: 'user@example.com', tag: await tag('user@example.com') },
      { value: '', tag: await tag('') },
      { value: 'पासवर्ड', tag: await tag('पासवर्ड') },
    ],
  },
  encoding: {
    base64url: [
      { bytesHex: '', encoded: '' },
      { bytesHex: '00', encoded: 'AA' },
      { bytesHex: 'fbffbeff', encoded: b64url(Buffer.from('fbffbeff', 'hex')) },
      {
        bytesHex: '000102030405060708090a0b0c0d0e0f',
        encoded: b64url(Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex')),
      },
    ],
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(vectors, null, 2)}\n`);
console.warn(`wrote ${outputPath}`);
