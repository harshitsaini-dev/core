'use client';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  deriveKeys,
  rewrapAccountKey,
  unwrapAccountKeys,
} from '@core/crypto';
import type { AccountKeys, Bytes } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import * as offline from './offline-db';

/**
 * Unlocking with a passkey.
 *
 * The obvious version of this feature does not work, and it is worth saying why
 * before the version that does.
 *
 * A passkey proves who you are by signing a challenge. A signature is not a
 * key — it cannot decrypt anything — so "sign in with Face ID" in a
 * zero-knowledge product would have to mean: the server sees a valid signature
 * and hands back something that opens the vault. That is a server that can open
 * vaults, which is the one thing this design does not permit.
 *
 * What makes it possible is the **PRF extension**. The authenticator derives 32
 * bytes from a salt and a secret held in hardware, returns the same 32 bytes
 * every time for the same salt, and never reveals the secret. That is key
 * material, not a signature — so the Account Key can be wrapped under it and
 * unwrapped by a fingerprint, with the server never involved and never able to.
 *
 * Where PRF is missing the feature is simply not offered. The fallback would be
 * storing the vault key behind a signature check the page performs on itself,
 * which is not security — it is an `if` statement in front of a secret.
 */

/** Domain separation, so the PRF output is only ever a Core vault key. */
const PRF_SALT = new TextEncoder().encode('core.passkey.v1');

/** What a passkey unlock needs, stored under the device key like everything else. */
export interface PasskeyMaterial {
  readonly email: string;
  /** The credential to ask for, base64url. Not a secret. */
  readonly credentialId: string;
  /** The Account Key, wrapped under the key the authenticator derives. */
  readonly accountKeyWrapped: string;
}

export class PasskeyUnsupported extends Error {
  constructor(message = 'This device cannot derive a key from a passkey.') {
    super(message);
    this.name = 'PasskeyUnsupported';
  }
}

export class PasskeyRejected extends Error {
  constructor(message = 'The passkey did not unlock the vault.') {
    super(message);
    this.name = 'PasskeyRejected';
  }
}

/** Whether the browser has the API at all. Says nothing about PRF. */
export function passkeysPossible(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof PublicKeyCredential !== 'undefined' &&
    typeof navigator.credentials?.create === 'function'
  );
}

function normalise(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

/** An AES key from the authenticator's 32 bytes. Non-extractable, like every other. */
async function keyFromPrf(output: ArrayBuffer): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', output, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** The PRF result from an assertion, or null when the authenticator has none. */
function prfOutput(credential: PublicKeyCredential): ArrayBuffer | null {
  const results = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  return results.prf?.results?.first ?? null;
}

export async function passkeyStatus(): Promise<{ enabled: boolean; email: string | null }> {
  const material = await offline.readPasskeyMaterial();
  return { enabled: material !== null, email: material?.email ?? null };
}

/**
 * Register a passkey and wrap the Account Key under what it derives.
 *
 * Takes the master password for the same reason the PIN does: the Account Key
 * exists only as a non-extractable `CryptoKey`, so re-wrapping it means opening
 * the stored wrapper again, which means deriving the Master Key.
 *
 * Two authenticator calls, not one. `create()` reports only whether PRF is
 * *available*; the values come from an assertion. Chrome returns nothing usable
 * from the create call on most authenticators, and building on the value it
 * sometimes returns would work on one laptop and fail on the next.
 */
export async function enablePasskey(email: string, masterPassword: string): Promise<void> {
  if (!passkeysPossible()) throw new PasskeyUnsupported('This browser has no passkey support.');

  const material = await offline.readUnlockMaterial();
  if (!material || material.email !== normalise(email)) {
    throw new PasskeyUnsupported('This device has not stored what a passkey needs. Sign in again.');
  }

  // The user handle. Derived from the address rather than fetched, because the
  // server's id for this account is not something the browser holds — and this
  // only has to be stable, not secret: a resident credential stores it, and
  // nothing here ever looks anything up by it.
  const userId = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalise(email))),
  ) as Bytes;

  const created = (await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'core' },
      user: { id: userId, name: normalise(email), displayName: normalise(email) },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: {
        // Platform only: the point is a fingerprint on this device, and a
        // roaming key that unlocks one browser's stored wrapper is a confusing
        // thing to own.
        authenticatorAttachment: 'platform',
        residentKey: 'required',
        userVerification: 'required',
      },
      extensions: { prf: {} } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!created) throw new PasskeyRejected('No passkey was created.');

  const support = created.getClientExtensionResults() as { prf?: { enabled?: boolean } };
  if (support.prf?.enabled !== true) {
    throw new PasskeyUnsupported(
      'This passkey cannot derive a key, so it could not open the vault without the server being able to as well.',
    );
  }

  const credentialId = bytesToBase64Url(new Uint8Array(created.rawId) as Bytes);
  const wrapKey = await assertPrfKey(credentialId);

  const { masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(material.kdfSalt),
    material.kdfParams as KdfParams,
  );

  let accountKeyWrapped: string;
  try {
    accountKeyWrapped = await rewrapAccountKey(masterKey, wrapKey, material.accountKeyWrapped);
  } catch {
    throw new PasskeyRejected('That master password is not right.');
  }

  await offline.writePasskeyMaterial({
    email: normalise(email),
    credentialId,
    accountKeyWrapped,
  });
}

/** Ask the authenticator for its PRF output and turn it into a key. */
async function assertPrfKey(credentialId: string): Promise<CryptoKey> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: base64UrlToBytes(credentialId) }],
      userVerification: 'required',
      extensions: {
        prf: { eval: { first: PRF_SALT } },
      } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new PasskeyRejected();

  const output = prfOutput(assertion);
  if (!output) {
    throw new PasskeyUnsupported('The authenticator returned no key material.');
  }

  return keyFromPrf(output);
}

export async function disablePasskey(): Promise<void> {
  await offline.clearPasskeyMaterial();
}

/**
 * Open the vault with a passkey.
 *
 * No attempt counter, unlike the PIN, and that is not an oversight. A PIN is
 * six digits and needs one; a passkey cannot be guessed, and the authenticator
 * enforces its own limits on the biometric in front of it. Adding a counter
 * here would only give somebody a way to destroy a working credential by
 * failing a fingerprint scan five times.
 */
export async function unlockWithPasskey(): Promise<AccountKeys> {
  const material = await offline.readPasskeyMaterial();
  if (!material) throw new PasskeyUnsupported();

  const wrapKey = await assertPrfKey(material.credentialId);

  try {
    return await unwrapAccountKeys(wrapKey, material.accountKeyWrapped);
  } catch {
    // The authenticator answered but its output does not open the wrapper. That
    // means a different credential, or a reset one — the vault is fine and the
    // master password still opens it.
    throw new PasskeyRejected('That passkey does not open this vault. Use your master password.');
  }
}
