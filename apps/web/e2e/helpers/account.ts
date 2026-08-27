import {
  bytesToBase64Url,
  createAccountKeys,
  createKeyPair,
  deriveKeys,
  deriveRecoveryVerifier,
  generateKdfSalt,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import { expect } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * Building a signup payload, in one place.
 *
 * Three specs used to construct this independently, which held until the signup
 * schema gained a required field and all three broke at once. Sharing it means
 * the next required field breaks compilation here rather than a dozen tests
 * somewhere else.
 *
 * The payload is built with the same `@core/crypto` the browser uses. Hardcoded
 * fixtures would let the tests drift from the client and quietly stop proving
 * the two agree on the wire format.
 */

/** Weak on purpose: production parameters cost half a second per derivation. */
export const FAST_KDF: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 8192,
  iterations: 1,
  parallelism: 1,
};

export interface SignupPayload {
  email: string;
  authKey: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  accountKeyWrapped: string;
  publicKey: string;
  privateKeyWrapped: string;
  recoveryVerifier: string;
}

export interface BuiltAccount {
  readonly payload: SignupPayload;
  /** Kept so a test can encrypt something before the account round-trips. */
  readonly keys: AccountKeys;
  readonly recoveryKey: string;
  readonly password: string;
}

export function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

/** Everything a browser does before it is allowed to talk to the server. */
export async function buildAccount(
  email: string,
  password = 'a strong master password',
): Promise<BuiltAccount> {
  const salt = generateKdfSalt();
  const { authKey, masterKey } = await deriveKeys(password, salt, FAST_KDF);
  const { keys, wrappedAccountKey, recoveryKey } = await createAccountKeys(masterKey);
  const { publicKey, wrappedPrivateKey } = await createKeyPair(keys.dataKey);

  return {
    keys,
    recoveryKey,
    password,
    payload: {
      email,
      authKey: bytesToBase64Url(authKey),
      kdfSalt: bytesToBase64Url(salt),
      kdfParams: FAST_KDF,
      accountKeyWrapped: wrappedAccountKey,
      publicKey,
      privateKeyWrapped: wrappedPrivateKey,
      recoveryVerifier: await deriveRecoveryVerifier(recoveryKey),
    },
  };
}

/** Create an account through the API and assert it worked. */
export async function register(
  request: APIRequestContext,
  label: string,
  password?: string,
): Promise<BuiltAccount> {
  const account = await buildAccount(uniqueEmail(label), password);
  const response = await request.post('/api/auth/signup', { data: account.payload });
  expect(response.status()).toBe(200);
  return account;
}

export async function loginWith(request: APIRequestContext, email: string, authKey: string) {
  return request.post('/api/auth/login', { data: { email, authKey } });
}
