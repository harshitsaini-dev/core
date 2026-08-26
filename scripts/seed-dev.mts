/**
 * Seed the local D1 replica with a test account.
 *
 *   pnpm db:seed
 *
 * Development only. It writes to the Miniflare replica under
 * `.wrangler/state/v3` and never touches the remote database.
 *
 * Why a script rather than fixtures in a test: the timing test for
 * `/api/auth/prelogin` can only prove anything if a *real* row exists to be
 * found. Comparing two lookups that both miss would pass trivially and tell us
 * nothing.
 *
 * Everything here is produced by the same `@core/crypto` and server helpers the
 * application uses, imported directly. Reimplementing the derivations would let
 * the seed drift from the real code and quietly make the timing test
 * meaningless.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  createAccountKeys,
  createKeyPair,
  deriveAuthVerifier,
  deriveKeys,
  encryptString,
  generateKdfSalt,
  bytesToBase64Url,
} from '@core/crypto';
import { DEFAULT_KDF_PARAMS } from '@core/shared';
import type { KdfParams } from '@core/shared';
import { emailIndex, parsePepper } from '../apps/web/lib/server/secrets.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

/** Weak on purpose: seeding should take a moment, not half a minute. */
const SEED_KDF_PARAMS: KdfParams = {
  ...DEFAULT_KDF_PARAMS,
  memoryKiB: 1024,
  iterations: 1,
};

export const SEED_USER = {
  email: 'seed@core.test',
  password: 'seed-master-password',
} as const;

function readDevPepper(): string {
  const contents = readFileSync(resolve(repoRoot, '.dev.vars'), 'utf8');
  const match = /^AUTH_PEPPER=(.+)$/m.exec(contents);
  if (!match?.[1]) {
    throw new Error('AUTH_PEPPER not found in .dev.vars');
  }
  return match[1].trim();
}

function sqlQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run SQL against the local replica.
 *
 * Via a temporary file rather than `--command`. Passing a multi-line statement
 * as an argument requires a shell on Windows, and the shell then splits the SQL
 * on whitespace — wrangler receives `DELETE` and treats the rest as unknown
 * arguments. A file has no quoting to get wrong.
 */
function execLocal(sql: string): void {
  const file = resolve(repoRoot, '.wrangler', `seed-${process.pid}.sql`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sql, 'utf8');
  try {
    execFileSync(
      'pnpm',
      ['exec', 'wrangler', 'd1', 'execute', 'core-vault', '--local', '--file', file],
      { cwd: repoRoot, stdio: 'pipe', shell: process.platform === 'win32' },
    );
  } finally {
    rmSync(file, { force: true });
  }
}

async function main(): Promise<void> {
  const pepper = parsePepper(readDevPepper());

  const salt = generateKdfSalt();
  const { authKey, masterKey } = await deriveKeys(SEED_USER.password, salt, SEED_KDF_PARAMS);
  const verifier = await deriveAuthVerifier(authKey, pepper);

  const { keys, wrappedAccountKey } = await createAccountKeys(masterKey);
  const { publicKey, wrappedPrivateKey } = await createKeyPair(keys.dataKey);
  const emailEnc = await encryptString(keys.dataKey, SEED_USER.email);

  const index = await emailIndex(pepper, SEED_USER.email);
  const now = Date.now();

  // Idempotent: re-running replaces the row rather than colliding on the
  // unique index, so the script is safe to run repeatedly.
  execLocal(`DELETE FROM users WHERE email_blind_index = ${sqlQuote(index)};`);
  execLocal(
    `INSERT INTO users (
       id, email_blind_index, email_enc, auth_verifier, kdf_salt, kdf_params,
       account_key_wrapped, public_key, private_key_wrapped,
       failed_attempts, created_at, updated_at
     ) VALUES (
       ${sqlQuote('seed-user')},
       ${sqlQuote(index)},
       ${sqlQuote(emailEnc)},
       ${sqlQuote(bytesToBase64Url(verifier))},
       ${sqlQuote(bytesToBase64Url(salt))},
       ${sqlQuote(JSON.stringify(SEED_KDF_PARAMS))},
       ${sqlQuote(wrappedAccountKey)},
       ${sqlQuote(publicKey)},
       ${sqlQuote(wrappedPrivateKey)},
       0, ${now}, ${now}
     );`,
  );

  console.warn(`Seeded ${SEED_USER.email} (password: ${SEED_USER.password})`);
  console.warn('Local replica only. Nothing was written to the remote database.');
}

await main();
