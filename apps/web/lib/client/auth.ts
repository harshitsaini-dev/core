import {
  bytesToBase64Url,
  base64UrlToBytes,
  calibrateKdf,
  createAccountKeys,
  createKeyPair,
  deriveKeys,
  deriveRecoveryVerifier,
  generateKdfSalt,
  recoverAccountKeys,
  unwrapAccountKeys,
  wipe,
  wrapRecoveryKey,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import * as offline from './offline-db';

/**
 * Key derivation, made cheap for the test suite.
 *
 * Calibration alone runs Argon2id repeatedly until one pass costs 500ms, and
 * then the real derivation runs on top of that — twice per test, once at signup
 * and once at unlock, each allocating 64 MiB. With several browsers doing it at
 * once the machine has nothing left, and tests fail on assertions that had
 * plenty of time and no CPU to use it in.
 *
 * So under `NEXT_PUBLIC_TEST_KDF` the calibration is skipped and fixed, weak
 * parameters are used instead. **This makes the derivation trivially cheap to
 * attack.** It exists in `.env.local`, which is git-ignored, and in the CI
 * workflows. It is never set in a production build, and `production-kdf.spec.ts`
 * asserts that a real build calibrates properly rather than taking this path.
 *
 * What it does not weaken is the thing worth testing: the algorithm, the
 * envelope, the wrapping, and every property the suite actually asserts are
 * identical. Only the cost parameter changes, and the cost parameter is what
 * `kdf.test.ts` covers directly.
 */
const TEST_KDF = process.env.NEXT_PUBLIC_TEST_KDF === '1';

const TEST_KDF_PARAMS: KdfParams = {
  algorithm: 'argon2id',
  memoryKiB: 8192,
  iterations: 1,
  parallelism: 1,
};

async function chooseKdfParams(): Promise<KdfParams> {
  if (TEST_KDF) return TEST_KDF_PARAMS;
  const { params } = await calibrateKdf();
  return params;
}

/**
 * The client half of authentication.
 *
 * Everything that touches the master password happens here, in the browser. The
 * password itself never reaches the network in any form — what goes out is an
 * Auth Key derived from it, which cannot be reversed and cannot decrypt
 * anything.
 *
 * The functions below are deliberately the only place that talks to the auth
 * endpoints, so there is one place to check that claim.
 */

export interface SignupResult {
  readonly keys: AccountKeys;
  /**
   * The Account Key, base64url. Shown to the user exactly once, on the
   * Emergency Kit, and never persisted or transmitted by this application.
   */
  readonly recoveryKey: string;
}

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    // Same-origin only; there is no reason for these to be cross-origin and
    // every reason not to allow it.
    credentials: 'same-origin',
  });
}

/**
 * Create an account.
 *
 * `onProgress` exists because the honest version of this is slow: calibrating
 * Argon2id and then running it costs a second or more on a phone, and a UI that
 * simply freezes reads as broken rather than as careful.
 */
export async function signup(
  email: string,
  masterPassword: string,
  onProgress?: (step: string) => void,
): Promise<SignupResult> {
  onProgress?.('calibrating key derivation');
  const params = await chooseKdfParams();

  onProgress?.('deriving keys');
  const salt = generateKdfSalt();
  const { authKey, masterKey } = await deriveKeys(masterPassword, salt, params);

  onProgress?.('generating account key');
  const { keys, wrappedAccountKey, recoveryKey } = await createAccountKeys(masterKey);
  const { publicKey, wrappedPrivateKey } = await createKeyPair(keys.dataKey);
  const recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);

  onProgress?.('creating account');
  const response = await postJson('/api/auth/signup', {
    email,
    authKey: bytesToBase64Url(authKey),
    kdfSalt: bytesToBase64Url(salt),
    kdfParams: params,
    accountKeyWrapped: wrappedAccountKey,
    publicKey,
    privateKeyWrapped: wrappedPrivateKey,
    recoveryVerifier,
  });

  wipe(authKey);

  if (!response.ok) {
    throw new Error('Could not create the account.');
  }

  return { keys, recoveryKey };
}

interface PreloginResponse {
  kdfSalt: string;
  kdfParams: KdfParams;
}

interface LoginResponse {
  accountKeyWrapped: string;
  publicKey: string;
  privateKeyWrapped: string;
}

/** Thrown for any authentication failure. Deliberately undifferentiated. */
export class LoginFailed extends Error {
  constructor() {
    super('Invalid credentials.');
    this.name = 'LoginFailed';
  }
}

/**
 * Log in and unlock.
 *
 * Two round trips, and they are not merged for a reason: the salt has to be
 * fetched before the key can be derived, and prelogin is deliberately
 * answerable without authentication so that it reveals nothing about whether an
 * account exists.
 */
export async function login(
  email: string,
  masterPassword: string,
  onProgress?: (step: string) => void,
): Promise<AccountKeys> {
  onProgress?.('fetching parameters');
  const pre = await postJson('/api/auth/prelogin', { email });
  if (!pre.ok) throw new LoginFailed();
  const { kdfSalt, kdfParams } = (await pre.json()) as PreloginResponse;

  onProgress?.('deriving keys');
  const { authKey, masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(kdfSalt),
    kdfParams,
  );

  onProgress?.('signing in');
  const response = await postJson('/api/auth/login', {
    email,
    authKey: bytesToBase64Url(authKey),
  });

  wipe(authKey);

  if (!response.ok) throw new LoginFailed();

  const body = (await response.json()) as LoginResponse;

  onProgress?.('unlocking vault');
  // If this throws, the server returned a wrapper this password cannot open —
  // which should be impossible after a successful login, and is worth surfacing
  // as a failure rather than an empty vault.
  const keys = await unwrapAccountKeys(masterKey, body.accountKeyWrapped);

  // Keep what is needed to do this again without a server. All three values are
  // ones the server hands out anyway; see the note in offline-db.
  await offline.writeUnlockMaterial({
    email: normalise(email),
    kdfSalt,
    kdfParams,
    accountKeyWrapped: body.accountKeyWrapped,
  });

  return keys;
}

/** Match the server's normalisation, so a cached record is found by any casing. */
function normalise(email: string): string {
  return email.normalize('NFKC').trim().toLowerCase();
}

/**
 * Unlock without a server.
 *
 * Used when the network is unavailable. The work is identical to the online
 * path minus the two requests: derive from the locally cached salt, unwrap the
 * locally cached Account Key, done.
 *
 * Tried only after the network path fails, never before. The server's copy is
 * authoritative — a password changed on another device has to win over whatever
 * this one remembers.
 */
export async function unlockOffline(
  email: string,
  masterPassword: string,
  onProgress?: (step: string) => void,
): Promise<AccountKeys> {
  const material = await offline.readUnlockMaterial();
  if (!material || material.email !== normalise(email)) {
    throw new LoginFailed();
  }

  onProgress?.('deriving keys offline');
  const { authKey, masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(material.kdfSalt),
    material.kdfParams as KdfParams,
  );
  wipe(authKey);

  try {
    return await unwrapAccountKeys(masterKey, material.accountKeyWrapped);
  } catch {
    // The wrapper did not open, which here means the wrong password. Reported
    // the same way as any other authentication failure.
    throw new LoginFailed();
  }
}

/** End the session. Best-effort: local state is cleared either way. */
export async function logout(everywhere = false): Promise<void> {
  await fetch(`/api/auth/logout${everywhere ? '?all=1' : ''}`, {
    method: 'POST',
    credentials: 'same-origin',
  }).catch(() => undefined);
}

/** Whether the browser still holds a live session. */
export async function hasSession(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/session', { credentials: 'same-origin' });
    return response.ok;
  } catch {
    return false;
  }
}

/** Thrown when a recovery key does not match the account. */
export class RecoveryFailed extends Error {
  constructor() {
    super('That recovery key does not match this account.');
    this.name = 'RecoveryFailed';
  }
}

/**
 * Set a new master password using the Emergency Kit.
 *
 * The vault is never re-encrypted. The recovery key *is* the Account Key, so
 * this decrypts nothing and re-encrypts nothing — it unwraps 32 bytes with the
 * old key and re-wraps the same 32 bytes under a key derived from the new
 * password. A vault of ten thousand items costs exactly as much as an empty one.
 *
 * The keys are returned so the caller can go straight to an unlocked vault
 * rather than asking for the password that was just set.
 */
export async function recover(
  email: string,
  recoveryKey: string,
  newPassword: string,
  onProgress?: (step: string) => void,
): Promise<AccountKeys> {
  onProgress?.('checking recovery key');

  let keys: AccountKeys;
  let recoveryVerifier: string;
  try {
    // Fails locally, before anything is sent, if the key is malformed.
    keys = await recoverAccountKeys(recoveryKey);
    recoveryVerifier = await deriveRecoveryVerifier(recoveryKey);
  } catch {
    throw new RecoveryFailed();
  }

  onProgress?.('calibrating key derivation');
  const params = await chooseKdfParams();

  onProgress?.('deriving new keys');
  const salt = generateKdfSalt();
  const { authKey, masterKey } = await deriveKeys(newPassword, salt, params);
  const accountKeyWrapped = await wrapRecoveryKey(masterKey, recoveryKey);

  onProgress?.('saving');
  const response = await postJson('/api/auth/recover', {
    email,
    recoveryVerifier,
    authKey: bytesToBase64Url(authKey),
    kdfSalt: bytesToBase64Url(salt),
    kdfParams: params,
    accountKeyWrapped,
  });

  wipe(authKey);

  if (!response.ok) throw new RecoveryFailed();

  return keys;
}
