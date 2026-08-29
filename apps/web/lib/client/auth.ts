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
  rewrapAccountKey,
  unwrapAccountKeys,
  wipe,
  wrapRecoveryKey,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';
import * as offline from './offline-db';
import { TURNSTILE_HEADER } from './turnstile';

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

async function postJson(path: string, body: unknown, botToken?: string): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // A header rather than a body field, so the server can refuse a request
      // before parsing anything a stranger sent it.
      ...(botToken ? { [TURNSTILE_HEADER]: botToken } : {}),
    },
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
  botToken?: string,
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
  const response = await postJson(
    '/api/auth/signup',
    {
      email,
      authKey: bytesToBase64Url(authKey),
      kdfSalt: bytesToBase64Url(salt),
      kdfParams: params,
      accountKeyWrapped: wrappedAccountKey,
      publicKey,
      privateKeyWrapped: wrappedPrivateKey,
      recoveryVerifier,
    },
    botToken,
  );

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
/**
 * The server refused because of how many requests arrived, not which.
 *
 * Distinguished from a failed sign-in on purpose, and it is not the leak that
 * distinction usually is: a 429 describes the caller's own request rate and
 * says nothing about whether an account exists or what its password is. It is
 * the same answer a stranger gets for hammering an address that was never
 * registered.
 *
 * Worth separating because the alternative is what this app used to do —
 * report "those credentials did not work" to somebody whose credentials were
 * never checked. Being told the wrong reason is worse than being told to wait.
 */
export class RateLimited extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super('Too many attempts from here. Try again shortly.');
    this.name = 'RateLimited';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Read `Retry-After`, falling back to a minute when it is missing or odd. */
function retryAfter(response: Response): number {
  const header = Number(response.headers.get('Retry-After'));
  return Number.isFinite(header) && header > 0 ? header : 60;
}

/**
 * The password was right and this browser is not recognised.
 *
 * Thrown rather than returned so a caller cannot forget to handle it: a
 * `login()` that resolved with "actually, no keys" would be one that somebody
 * eventually treats as success.
 *
 * Only reachable after a correct password, so it says nothing a caller has not
 * already established.
 */
export class DeviceVerificationRequired extends Error {
  constructor() {
    super('Enter the code sent to your email.');
    this.name = 'DeviceVerificationRequired';
  }
}

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
  botToken?: string,
): Promise<AccountKeys> {
  onProgress?.('fetching parameters');
  const pre = await postJson('/api/auth/prelogin', { email });
  if (pre.status === 429) throw new RateLimited(retryAfter(pre));
  if (!pre.ok) throw new LoginFailed();
  const { kdfSalt, kdfParams } = (await pre.json()) as PreloginResponse;

  onProgress?.('deriving keys');
  const { authKey, masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(kdfSalt),
    kdfParams,
  );

  onProgress?.('signing in');
  const response = await postJson(
    '/api/auth/login',
    { email, authKey: bytesToBase64Url(authKey) },
    botToken,
  );

  wipe(authKey);

  // A refusal by rate is not a refusal by password, and saying so is not a
  // leak: it describes this caller's request rate, not the account.
  if (response.status === 429) throw new RateLimited(retryAfter(response));
  if (!response.ok) throw new LoginFailed();

  const body = (await response.json()) as LoginResponse & { status?: string };

  // A correct password from a browser this account has not verified. No keys
  // came back and no session was issued; the code completes the sign-in.
  if (body.status === 'verify') throw new DeviceVerificationRequired();

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

/** The current password was wrong, which is the only failure worth naming. */
export class PasswordChangeRejected extends Error {
  constructor() {
    super('That is not your current master password.');
    this.name = 'PasswordChangeRejected';
  }
}

/**
 * Change the master password.
 *
 * The operation the Account Key indirection exists for. The vault is encrypted
 * under the Account Key, which does not change; only the thirty-two-byte
 * wrapper around it is replaced. A vault of ten thousand items costs the same to
 * re-key as an empty one, and none of it is re-uploaded.
 *
 * The current password is required as well as an unlocked tab. A session proves
 * a browser was left open; it does not prove the person at the keyboard knows
 * the password, and changing it is precisely what somebody who found an
 * unlocked laptop would do — it would lock the owner out for good.
 *
 * The keys returned are the same keys. Nothing the vault holds needs touching,
 * which is the point.
 */
export async function changeMasterPassword(
  email: string,
  currentPassword: string,
  newPassword: string,
  onProgress?: (step: string) => void,
): Promise<void> {
  onProgress?.('checking your current password');

  // Prelogin gives the parameters the current password was derived under. They
  // are not assumed to match today's defaults: an old account may have been
  // created on a slower phone.
  const pre = await fetch('/api/auth/prelogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email }),
  });
  if (!pre.ok) throw new Error('Could not reach the server.');

  const { kdfSalt, kdfParams } = (await pre.json()) as { kdfSalt: string; kdfParams: KdfParams };

  const older = await deriveKeys(currentPassword, base64UrlToBytes(kdfSalt), kdfParams);

  onProgress?.('deriving new keys');
  const params = await chooseKdfParams();
  const salt = generateKdfSalt();
  const fresh = await deriveKeys(newPassword, salt, params);

  onProgress?.('re-wrapping your account key');

  // Read back from the server rather than from anything cached: the wrapper is
  // the one thing that must be the current one, and a stale copy would produce
  // a wrapper nobody can open.
  const session = await fetch('/api/auth/session', { credentials: 'same-origin' });
  if (!session.ok) throw new Error('Your session has expired. Unlock again and retry.');

  const material = await offline.readUnlockMaterial();
  if (!material) {
    throw new Error('This device has not stored what a password change needs. Sign in again.');
  }

  let accountKeyWrapped: string;
  try {
    accountKeyWrapped = await rewrapAccountKey(
      older.masterKey,
      fresh.masterKey,
      material.accountKeyWrapped,
    );
  } catch {
    // The old master key did not open the wrapper, so the current password was
    // wrong. Caught here rather than at the server, which never sees a password.
    throw new PasswordChangeRejected();
  }

  onProgress?.('saving');
  const response = await fetch('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({
      currentAuthKey: bytesToBase64Url(older.authKey),
      authKey: bytesToBase64Url(fresh.authKey),
      kdfSalt: bytesToBase64Url(salt),
      kdfParams: params,
      accountKeyWrapped,
    }),
  });

  if (!response.ok) throw new PasswordChangeRejected();

  // The cached unlock material describes the old password. Left behind, an
  // offline unlock would keep accepting it — which would mean the password had
  // not really changed on this device.
  await offline.writeUnlockMaterial({
    email,
    kdfSalt: bytesToBase64Url(salt),
    kdfParams: params,
    accountKeyWrapped,
  });

  wipe(older.authKey);
  wipe(fresh.authKey);
}

/**
 * Finish a sign-in with the code emailed to the account.
 *
 * The same unwrap as an ordinary sign-in, from the same wrapped material. The
 * code released a session; the master password is what opens the vault, and
 * this still derives the Master Key from it here in the browser.
 */
export async function verifyDevice(
  email: string,
  masterPassword: string,
  code: string,
  onProgress?: (step: string) => void,
): Promise<AccountKeys> {
  onProgress?.('fetching parameters');
  const pre = await postJson('/api/auth/prelogin', { email });
  if (pre.status === 429) throw new RateLimited(retryAfter(pre));
  if (!pre.ok) throw new LoginFailed();
  const { kdfSalt, kdfParams } = (await pre.json()) as PreloginResponse;

  onProgress?.('checking the code');
  const response = await postJson('/api/auth/verify-device', { email, code });
  if (response.status === 429) throw new RateLimited(retryAfter(response));
  if (!response.ok) throw new LoginFailed();

  const body = (await response.json()) as LoginResponse;

  onProgress?.('deriving keys');
  const { authKey, masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(kdfSalt),
    kdfParams,
  );
  wipe(authKey);

  onProgress?.('unlocking vault');
  const keys = await unwrapAccountKeys(masterKey, body.accountKeyWrapped);

  await offline.writeUnlockMaterial({
    email: normalise(email),
    kdfSalt,
    kdfParams,
    accountKeyWrapped: body.accountKeyWrapped,
  });

  return keys;
}
