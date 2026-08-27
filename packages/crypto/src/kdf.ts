import { argon2id } from 'hash-wasm';
import { DEFAULT_KDF_PARAMS, KDF_CONTEXT, PBKDF2_FALLBACK_PARAMS, SIZES } from '@core/shared';
import type { KdfParams } from '@core/shared';
import type { Bytes } from './encoding.js';
import { utf8ToBytes, wipe } from './encoding.js';
import { randomBytes } from './random.js';

/**
 * Key derivation: turning a master password into keys.
 *
 * The design deliberately runs the expensive KDF **once** and then splits its
 * output with HKDF, rather than running Argon2id twice with different context
 * strings. Two runs would double the cost of every unlock while adding nothing:
 * the security of both keys already rests entirely on that single Argon2id
 * computation, and HKDF-Expand gives cryptographic domain separation for free.
 *
 *   Argon2id(password, salt) -> 32-byte root
 *      |
 *      +-- HKDF-Expand(root, "core.auth.v1") -> Auth Key       (leaves the device)
 *      +-- HKDF-Expand(root, "core.enc.v1")  -> Master Key     (never leaves)
 *
 * The Auth Key is sent to the server on login. The Master Key exists only to
 * wrap and unwrap the Account Key, and is returned as a non-extractable
 * `CryptoKey` so that application code cannot accidentally serialise it.
 */

export interface DerivedKeys {
  /** Sent to the server to prove identity. Raw bytes, base64url on the wire. */
  readonly authKey: Bytes;
  /** Wraps the Account Key. Non-extractable; never leaves the device. */
  readonly masterKey: CryptoKey;
}

/** A fresh per-user KDF salt. Public — it is stored and served in the clear. */
export function generateKdfSalt(): Bytes {
  return randomBytes(SIZES.salt);
}

function assertValidParams(params: KdfParams): void {
  if (params.algorithm === 'argon2id') {
    if (params.memoryKiB < 8) throw new RangeError('Argon2id memoryKiB must be at least 8');
    if (params.iterations < 1) throw new RangeError('Argon2id iterations must be at least 1');
    if (params.parallelism < 1) throw new RangeError('Argon2id parallelism must be at least 1');
    return;
  }
  if (params.iterations < 100_000) {
    // Far below current guidance; almost certainly a mistake or a downgrade attempt.
    throw new RangeError('PBKDF2 iterations must be at least 100000');
  }
}

/**
 * Run the expensive part: password + salt -> 32-byte root key.
 *
 * Exported mainly so that tests and the calibration helper can measure it.
 */
export async function deriveRootKey(
  masterPassword: string,
  salt: Bytes,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<Bytes> {
  if (salt.length < 8) throw new RangeError('KDF salt must be at least 8 bytes');
  assertValidParams(params);

  if (params.algorithm === 'argon2id') {
    // Copied into a fresh buffer: hash-wasm types its output as a generic
    // Uint8Array, which WebCrypto will not accept downstream.
    return new Uint8Array(
      await argon2id({
        password: masterPassword,
        salt,
        parallelism: params.parallelism,
        iterations: params.iterations,
        memorySize: params.memoryKiB,
        hashLength: SIZES.key,
        outputType: 'binary',
      }),
    );
  }

  const passwordBytes = utf8ToBytes(masterPassword);
  try {
    const baseKey = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, [
      'deriveBits',
    ]);
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: params.iterations, hash: 'SHA-512' },
      baseKey,
      SIZES.key * 8,
    );
    return new Uint8Array(bits);
  } finally {
    wipe(passwordBytes);
  }
}

/** HKDF-Expand a root key into one labelled sub-key. */
async function expand(root: Bytes, info: string, length: number): Promise<Bytes> {
  const hkdfKey = await crypto.subtle.importKey('raw', root, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // The root is already uniformly random, so an empty salt is correct here.
      salt: new Uint8Array(0),
      info: utf8ToBytes(info),
    },
    hkdfKey,
    length * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive the Auth Key and the Master Key from a master password.
 *
 * The root key and the raw master-key bytes are wiped before returning, so the
 * only lasting references are the returned Auth Key bytes and a non-extractable
 * `CryptoKey`.
 */
export async function deriveKeys(
  masterPassword: string,
  salt: Bytes,
  params: KdfParams = DEFAULT_KDF_PARAMS,
): Promise<DerivedKeys> {
  const root = await deriveRootKey(masterPassword, salt, params);
  try {
    const authKey = await expand(root, KDF_CONTEXT.auth, SIZES.key);
    const masterKeyBytes = await expand(root, KDF_CONTEXT.encryption, SIZES.key);
    try {
      const masterKey = await crypto.subtle.importKey(
        'raw',
        masterKeyBytes,
        { name: 'AES-GCM' },
        // Non-extractable: the master key can wrap and unwrap, and nothing else.
        false,
        ['encrypt', 'decrypt'],
      );
      return { authKey, masterKey };
    } finally {
      wipe(masterKeyBytes);
    }
  } finally {
    wipe(root);
  }
}

/**
 * The value the server stores and compares against.
 *
 * `HMAC-SHA256(pepper, authKey)`, not another Argon2id pass. The Auth Key is
 * already the output of an expensive memory-hard derivation, so an attacker
 * holding the database still has to pay the full Argon2id cost per password
 * guess. Repeating that work on the server would buy no additional resistance
 * and would hand anyone a cheap way to exhaust the Worker's CPU budget.
 *
 * The pepper lives in the Worker's secret store, never in the database. Without
 * it, an attacker with a full database dump cannot even begin an offline attack.
 */
export async function deriveAuthVerifier(authKey: Bytes, pepper: Bytes): Promise<Bytes> {
  if (pepper.length < 16) {
    throw new RangeError('Auth pepper must be at least 16 bytes');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    pepper,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, authKey));
}

export interface KdfCalibration {
  readonly params: KdfParams;
  readonly measuredMs: number;
}

/**
 * Find Argon2id parameters that cost roughly `targetMs` on *this* device.
 *
 * Called once at signup. The result is stored per user, so a phone that
 * calibrates low is not later locked out by a laptop raising the defaults.
 * Memory is held at 64 MiB — the property that actually frustrates GPU attacks —
 * and only the iteration count is tuned.
 *
 * `DEFAULT_KDF_PARAMS` is a floor, not a target. On a 2026 desktop it costs
 * around 140 ms, which is well short of the 500 ms this project aims for; the
 * iteration ceiling is set high enough that fast hardware is actually driven up
 * to the target rather than quietly settling below it.
 */
export async function calibrateKdf(targetMs = 500, maxIterations = 24): Promise<KdfCalibration> {
  const salt = generateKdfSalt();
  const probe = 'calibration-probe-password';

  let iterations = 1;
  let measuredMs = 0;

  for (; iterations <= maxIterations; iterations += 1) {
    const params: KdfParams = { ...DEFAULT_KDF_PARAMS, iterations };
    const started = performance.now();
    wipe(await deriveRootKey(probe, salt, params));
    measuredMs = performance.now() - started;
    if (measuredMs >= targetMs) {
      return { params, measuredMs };
    }
  }

  return { params: { ...DEFAULT_KDF_PARAMS, iterations: maxIterations }, measuredMs };
}

/**
 * Whether stored parameters are still considered acceptable.
 *
 * Used to prompt an upgrade on login when a vault was created under weaker
 * settings. Upgrading only re-derives keys and re-wraps the Account Key; vault
 * items are untouched.
 */
export function isBelowCurrentPolicy(params: KdfParams): boolean {
  if (params.algorithm === 'pbkdf2-sha512') {
    return params.iterations < PBKDF2_FALLBACK_PARAMS.iterations;
  }
  return (
    params.memoryKiB < DEFAULT_KDF_PARAMS.memoryKiB ||
    params.iterations < DEFAULT_KDF_PARAMS.iterations
  );
}
