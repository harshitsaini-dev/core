import {
  bytesToBase64Url,
  base64UrlToBytes,
  calibrateKdf,
  createAccountKeys,
  createKeyPair,
  deriveKeys,
  generateKdfSalt,
  unwrapAccountKeys,
  wipe,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type { KdfParams } from '@core/shared';

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
  const { params } = await calibrateKdf();

  onProgress?.('deriving keys');
  const salt = generateKdfSalt();
  const { authKey, masterKey } = await deriveKeys(masterPassword, salt, params);

  onProgress?.('generating account key');
  const { keys, wrappedAccountKey, recoveryKey } = await createAccountKeys(masterKey);
  const { publicKey, wrappedPrivateKey } = await createKeyPair(keys.dataKey);

  onProgress?.('creating account');
  const response = await postJson('/api/auth/signup', {
    email,
    authKey: bytesToBase64Url(authKey),
    kdfSalt: bytesToBase64Url(salt),
    kdfParams: params,
    accountKeyWrapped: wrappedAccountKey,
    publicKey,
    privateKeyWrapped: wrappedPrivateKey,
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
  return unwrapAccountKeys(masterKey, body.accountKeyWrapped);
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
