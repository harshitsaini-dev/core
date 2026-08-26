import { HKDF_INFO, SIZES } from '@core/shared';
import { decryptBytes, encryptBytes, importAesKey } from './aes.js';
import type { Bytes } from './encoding.js';
import { base64UrlToBytes, bytesToBase64Url, utf8ToBytes, wipe } from './encoding.js';
import { randomBytes } from './random.js';

/**
 * The Account Key and everything derived from it.
 *
 * The indirection between the master password and the data is the reason
 * changing a master password is cheap:
 *
 *   Master Key (from password)  --wraps-->  Account Key  --encrypts-->  vault
 *
 * Changing the password re-wraps 32 bytes. Not one vault item is touched.
 *
 * The raw Account Key exists only for the moments needed to wrap it, derive its
 * sub-keys, and hand a copy to the Emergency Kit. Everything returned to callers
 * is a non-extractable `CryptoKey`.
 */

export interface AccountKeys {
  /** AES-GCM key that encrypts every vault item. */
  readonly dataKey: CryptoKey;
  /** HMAC key for blind indexes. Derived, never stored. */
  readonly blindIndexKey: CryptoKey;
}

export interface NewAccount {
  readonly keys: AccountKeys;
  /** The Account Key encrypted under the Master Key. Safe to store server-side. */
  readonly wrappedAccountKey: string;
  /**
   * The Account Key itself, base64url.
   *
   * This single string can decrypt the entire vault without the master
   * password. It goes into the Emergency Kit, is shown to the user exactly
   * once, and must never be transmitted or persisted by the application.
   */
  readonly recoveryKey: string;
}

/** Domain separation string used when wrapping the Account Key. */
const ACCOUNT_KEY_AAD = 'core.account-key.v1';

async function deriveAccountKeys(raw: Bytes): Promise<AccountKeys> {
  const hkdfKey = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits']);

  const blindIndexBits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: utf8ToBytes(HKDF_INFO.blindIndex),
    },
    hkdfKey,
    SIZES.key * 8,
  );
  const blindIndexBytes = new Uint8Array(blindIndexBits);

  try {
    const [dataKey, blindIndexKey] = await Promise.all([
      importAesKey(raw),
      crypto.subtle.importKey('raw', blindIndexBytes, { name: 'HMAC', hash: 'SHA-256' }, false, [
        'sign',
      ]),
    ]);
    return { dataKey, blindIndexKey };
  } finally {
    wipe(blindIndexBytes);
  }
}

/**
 * Create a brand new account: a random Account Key, wrapped under the Master
 * Key, plus the recovery string for the Emergency Kit.
 */
export async function createAccountKeys(masterKey: CryptoKey): Promise<NewAccount> {
  const raw = randomBytes(SIZES.key);
  try {
    const [keys, wrappedAccountKey] = await Promise.all([
      deriveAccountKeys(raw),
      encryptBytes(masterKey, raw, ACCOUNT_KEY_AAD),
    ]);
    return { keys, wrappedAccountKey, recoveryKey: bytesToBase64Url(raw) };
  } finally {
    wipe(raw);
  }
}

/** Unwrap a stored Account Key using the Master Key derived at unlock. */
export async function unwrapAccountKeys(
  masterKey: CryptoKey,
  wrappedAccountKey: string,
): Promise<AccountKeys> {
  const raw = await decryptBytes(masterKey, wrappedAccountKey, ACCOUNT_KEY_AAD);
  try {
    return await deriveAccountKeys(raw);
  } finally {
    wipe(raw);
  }
}

/** Recover an account from the Emergency Kit string, with no master password. */
export async function recoverAccountKeys(recoveryKey: string): Promise<AccountKeys> {
  const raw = base64UrlToBytes(recoveryKey.trim());
  if (raw.length !== SIZES.key) {
    throw new RangeError('Recovery key must decode to exactly 32 bytes');
  }
  try {
    return await deriveAccountKeys(raw);
  } finally {
    wipe(raw);
  }
}

/**
 * Re-wrap the Account Key under a new Master Key.
 *
 * This is the entire master-password change operation. If this function ever
 * grows a parameter that looks like vault data, something has gone wrong with
 * the design.
 */
export async function rewrapAccountKey(
  oldMasterKey: CryptoKey,
  newMasterKey: CryptoKey,
  wrappedAccountKey: string,
): Promise<string> {
  const raw = await decryptBytes(oldMasterKey, wrappedAccountKey, ACCOUNT_KEY_AAD);
  try {
    return await encryptBytes(newMasterKey, raw, ACCOUNT_KEY_AAD);
  } finally {
    wipe(raw);
  }
}

/** Wrap a known Account Key under a Master Key — used when restoring from a kit. */
export async function wrapRecoveryKey(
  masterKey: CryptoKey,
  recoveryKey: string,
): Promise<string> {
  const raw = base64UrlToBytes(recoveryKey.trim());
  if (raw.length !== SIZES.key) {
    throw new RangeError('Recovery key must decode to exactly 32 bytes');
  }
  try {
    return await encryptBytes(masterKey, raw, ACCOUNT_KEY_AAD);
  } finally {
    wipe(raw);
  }
}
