'use client';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  deriveKeys,
  derivePinKey,
  generatePinSalt,
  isValidPin,
  rewrapAccountKey,
  unwrapAccountKeys,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import * as offline from './offline-db';

/**
 * Quick unlock with a PIN.
 *
 * What this trades is stated once, here, because every other comment in the
 * file depends on it: enabling a PIN means this device can open the vault
 * without the master password. That is the feature. It is not a smaller version
 * of the master password and it is not additional security — it is a
 * convenience bought with a real reduction in what it takes to get in on this
 * one device.
 *
 * Three things keep the trade honest:
 *
 *   1. Setting a PIN costs the master password. The wrapped Account Key has to
 *      be re-wrapped, which needs the Master Key, which needs the password. So
 *      turning this on is a deliberate act by somebody who already knows the
 *      secret, not something an onlooker can do with an unlocked tab.
 *
 *   2. The material is sealed under the device key, so it cannot be carried off
 *      the profile and ground through at leisure.
 *
 *   3. Five wrong PINs and it is gone — not locked out for a while, gone. The
 *      vault still opens with the master password, which is what has entropy.
 *      That is the whole rate limit, and it is counted on disk.
 */

/** Wrong attempts before the stored material is destroyed. */
export const PIN_ATTEMPT_LIMIT = 5;

export class PinRejected extends Error {
  /** Attempts left after this one. Zero means the PIN is gone. */
  readonly remaining: number;

  constructor(remaining: number) {
    super(
      remaining > 0
        ? `Wrong PIN. ${remaining} ${remaining === 1 ? 'try' : 'tries'} left.`
        : 'Wrong PIN. Quick unlock is off; use your master password.',
    );
    this.name = 'PinRejected';
    this.remaining = remaining;
  }
}

export class PinUnavailable extends Error {
  constructor(message = 'Quick unlock is not set up on this device.') {
    super(message);
    this.name = 'PinUnavailable';
  }
}

/** Match the server's normalisation, so a stored record is found by any casing. */
function normalise(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

/** Whether this device can offer quick unlock, and for whom. */
export async function pinStatus(): Promise<{ enabled: boolean; email: string | null }> {
  const material = await offline.readPinMaterial();
  return { enabled: material !== null, email: material?.email ?? null };
}

/**
 * Turn quick unlock on.
 *
 * Takes the master password rather than the keys already in memory, and the
 * reason is not ceremony: the Account Key is only ever held as a non-extractable
 * `CryptoKey`, so there is nothing in memory to re-wrap. The wrapper has to be
 * opened again with the Master Key, which means deriving it, which means the
 * password. The security property that falls out of that is worth having
 * anyway — see the note at the top.
 */
export async function enablePin(email: string, masterPassword: string, pin: string): Promise<void> {
  if (!isValidPin(pin)) {
    throw new PinRejected(PIN_ATTEMPT_LIMIT);
  }

  const material = await offline.readUnlockMaterial();
  if (!material || material.email !== normalise(email)) {
    throw new PinUnavailable('This device has not stored what quick unlock needs. Sign in again.');
  }

  const { masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(material.kdfSalt),
    material.kdfParams as KdfParams,
  );

  const salt = generatePinSalt();
  const pinKey = await derivePinKey(pin, salt);

  // Throws if the password was wrong: the wrapper will not open. Reported as
  // `PinUnavailable` rather than as a wrong PIN, because that is what happened.
  let accountKeyWrapped: string;
  try {
    accountKeyWrapped = await rewrapAccountKey(masterKey, pinKey, material.accountKeyWrapped);
  } catch {
    throw new PinUnavailable('That master password is not right.');
  }

  await offline.writePinMaterial({
    email: normalise(email),
    salt: bytesToBase64Url(salt),
    accountKeyWrapped,
    attempts: 0,
  });
}

/** Turn it off and forget the material. */
export async function disablePin(): Promise<void> {
  await offline.clearPinMaterial();
}

/**
 * Open the vault with a PIN.
 *
 * The attempt is written down *before* it is tried. Counting after a failure
 * loses every attempt that ends by closing the tab, which is the one an
 * attacker would use — and it would turn a five-try limit into no limit at all
 * for anyone willing to press Escape.
 */
export async function unlockWithPin(pin: string): Promise<AccountKeys> {
  const material = await offline.readPinMaterial();
  if (!material) throw new PinUnavailable();

  const used = material.attempts + 1;
  const remaining = PIN_ATTEMPT_LIMIT - used;

  if (remaining < 0) {
    await offline.clearPinMaterial();
    throw new PinRejected(0);
  }

  await offline.writePinMaterial({ ...material, attempts: used });

  try {
    const pinKey = await derivePinKey(pin, base64UrlToBytes(material.salt));
    const keys = await unwrapAccountKeys(pinKey, material.accountKeyWrapped);

    // Only a success resets the count. Anything else leaves it where the
    // failure put it, including a reload in between.
    await offline.writePinMaterial({ ...material, attempts: 0 });
    return keys;
  } catch {
    if (remaining <= 0) {
      await offline.clearPinMaterial();
      throw new PinRejected(0);
    }
    throw new PinRejected(remaining);
  }
}
