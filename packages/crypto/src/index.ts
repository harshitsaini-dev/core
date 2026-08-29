/**
 * @core/crypto
 *
 * Every cryptographic operation in Core. This package is deliberately isolated
 * so that the zero-knowledge claim can be audited by reading one small
 * directory rather than the whole application.
 *
 * Constraints, enforced by lint rules and by review:
 *   - no React, no Next.js, no `node:*` imports
 *   - no network access
 *   - no `Math.random` — see random.ts
 *   - no logging of key material or plaintext
 *
 * The shape of the system:
 *
 *   master password
 *      -> Argon2id  ................................  kdf.ts
 *      -> HKDF split into Auth Key + Master Key .....  kdf.ts
 *      -> Master Key unwraps the Account Key ........  account.ts
 *      -> Account Key encrypts every item ...........  aes.ts
 *      -> Account Key derives the blind-index key ...  blind-index.ts
 *      -> Account Key wraps the ECDH private key ....  sharing.ts
 *
 * Also here, because it is HMAC arithmetic and belongs beside the rest:
 *      TOTP / HOTP (RFC 6238, RFC 4226) ...............  totp.ts
 */

export * from './encoding.js';
export * from './random.js';
export * from './kdf.js';
export * from './aes.js';
export * from './account.js';
export * from './pin.js';
export * from './blind-index.js';
export * from './sharing.js';
export * from './totp.js';
export * from './migration.js';
