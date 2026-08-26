/**
 * @core/crypto
 *
 * All cryptographic operations for Core live here. This package is
 * intentionally isolated so that the zero-knowledge claim can be audited by
 * reading one small directory.
 *
 * Constraints, enforced by lint rules and by review:
 *   - no React, no Next.js, no `node:*` imports
 *   - no network access
 *   - no logging of key material or plaintext
 */

export * from './encoding.js';
