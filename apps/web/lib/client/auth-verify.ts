'use client';

import { base64UrlToBytes, deriveKeys, unwrapAccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import * as offline from './offline-db';

/**
 * Prove that somebody knows the master password, right now.
 *
 * Used to gate an action that is dangerous rather than merely destructive — a
 * plaintext export — where the vault is already unlocked and the keys are
 * already in memory. Checking a flag would be checking nothing; what has to be
 * established is that the person at the keyboard is the one who opened it,
 * which may have been hours ago on a machine they have since walked away from.
 *
 * Done locally and without a round trip. The wrapped Account Key is already on
 * this device, and a key derived from the wrong password will not open it —
 * that is not a comparison the code performs and could get wrong, it is
 * AES-GCM's authentication tag refusing. The same property the offline unlock
 * path relies on.
 *
 * It costs a full Argon2id derivation, which is the point: a wrong guess is as
 * expensive here as it is anywhere else.
 */
export async function verifyMasterPassword(password: string): Promise<boolean> {
  // The address comes from the same record as the wrapper, rather than being
  // passed in. There is exactly one account this device can open, and asking a
  // screen to supply it would be asking it to get it right.
  const material = await offline.readUnlockMaterial();
  if (!material) return false;

  try {
    const { masterKey } = await deriveKeys(
      password,
      base64UrlToBytes(material.kdfSalt),
      material.kdfParams as KdfParams,
    );

    await unwrapAccountKeys(masterKey, material.accountKeyWrapped);
    return true;
  } catch {
    return false;
  }
}
