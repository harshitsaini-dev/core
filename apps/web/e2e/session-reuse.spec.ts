import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToBase64Url } from '@core/crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { emailIndex, parsePepper } from '../lib/server/secrets';
import { loginWith, register } from './helpers/account';

/**
 * Refresh-token reuse detection.
 *
 * Rotation replaces a token and records the hash it replaced. If that old token
 * ever comes back, a copy of it is in circulation — the legitimate client
 * replaced it and moved on, so nothing honest would present it again.
 *
 * Testing this needs a session old enough to rotate, and sessions rotate at half
 * their seven-day life. Rather than adding a "rotate sooner" knob that could
 * weaken production if it were ever set by accident, these tests age the row in
 * the database directly. The code under test is exactly the code that ships.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Run SQL against the local replica and return wrangler's output.
 *
 * Always through a file, never `--command`. Passing SQL as an argument needs a
 * shell on Windows, and the shell then splits it on whitespace — wrangler sees
 * `SELECT` and rejects the rest as unknown arguments.
 */
function execLocal(sql: string): string {
  const file = resolve(repoRoot, '.wrangler', `e2e-${crypto.randomUUID()}.sql`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, sql, 'utf8');
  try {
    return execFileSync(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        'execute',
        'core-vault',
        '--local',
        '--json',
        '--config',
        'apps/web/wrangler.toml',
        '--persist-to',
        '.wrangler/state',
        '--file',
        file,
      ],
      { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' },
    );
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Push a user's live sessions close enough to expiry that the next request
 * rotates one. Half of seven days is the threshold, so a day of remaining life
 * comfortably qualifies.
 *
 * Scoped to a single user, deliberately. An earlier version aged "the newest
 * session" and passed locally, where Playwright runs one worker — then failed
 * in CI, where two workers run concurrently and the newest session frequently
 * belongs to a different test.
 *
 * The lookup reuses the server's own `emailIndex` rather than reimplementing
 * the derivation, so the test cannot drift from the code it is exercising.
 */
async function ageSessionsFor(email: string): Promise<void> {
  const pepper = parsePepper(devPepper());
  const index = await emailIndex(pepper, email);
  const oneDayFromNow = Date.now() + 24 * 60 * 60 * 1000;

  execLocal(
    `UPDATE sessions SET expires_at = ${oneDayFromNow}
     WHERE revoked_at IS NULL
       AND user_id = (
         SELECT id FROM users WHERE email_blind_index = '${index.replace(/'/g, "''")}'
       );`,
  );
}

/** The pepper the dev server is running with. CI sets it in the environment. */
function devPepper(): string {
  const fromEnv = process.env.AUTH_PEPPER?.trim();
  if (fromEnv) return fromEnv;

  const match = /^AUTH_PEPPER=(.+)$/m.exec(
    readFileSync(resolve(repoRoot, 'apps/web/.dev.vars'), 'utf8'),
  );
  if (!match?.[1]) throw new Error('AUTH_PEPPER not found');
  return match[1].trim();
}

async function registerAndLogin(request: APIRequestContext, label: string): Promise<string> {
  const account = await register(request, label);
  const response = await loginWith(request, account.payload.email, account.payload.authKey);
  expect(response.status()).toBe(200);
  return account.payload.email;
}

/** Read the session cookie the request context is currently carrying. */
async function currentToken(request: APIRequestContext): Promise<string> {
  const state = await request.storageState();
  const cookie = state.cookies.find((candidate) => candidate.name === 'core_session');
  expect(cookie, 'expected a session cookie').toBeDefined();
  return cookie?.value ?? '';
}

test.describe('session rotation', () => {
  test('rotates a session that is past half its life', async ({ request }) => {
    const email = await registerAndLogin(request, 'rotate');
    const before = await currentToken(request);

    await ageSessionsFor(email);

    const response = await request.get('/api/auth/session');
    expect(response.status()).toBe(200);
    expect(response.headers()['set-cookie'] ?? '').toContain('core_session=');

    expect(await currentToken(request)).not.toBe(before);
  });

  test('leaves a fresh session alone', async ({ request }) => {
    await registerAndLogin(request, 'norotate');
    const before = await currentToken(request);

    const response = await request.get('/api/auth/session');
    expect(response.status()).toBe(200);
    // Rotating on every request would churn the sessions table for no gain.
    expect(await currentToken(request)).toBe(before);
  });
});

test.describe('reuse detection', () => {
  test('rejects a token that was already rotated away', async ({ request, playwright }) => {
    const email = await registerAndLogin(request, 'reuse');
    const stolen = await currentToken(request);

    await ageSessionsFor(email);
    await request.get('/api/auth/session');
    expect(await currentToken(request)).not.toBe(stolen);

    const attacker = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { cookie: `core_session=${stolen}` },
    });

    expect((await attacker.get('/api/auth/session')).status()).toBe(401);
    await attacker.dispose();
  });

  test('revokes the whole chain, not just the replayed token', async ({ request, playwright }) => {
    // The point of the design. There is no way to tell whether the replay or the
    // live session is the attacker, so both have to go — signing the real user
    // out is an inconvenience, leaving an attacker signed in is not.
    const email = await registerAndLogin(request, 'chain');
    const stolen = await currentToken(request);

    await ageSessionsFor(email);
    await request.get('/api/auth/session');

    // The legitimate client is still working at this point.
    expect((await request.get('/api/auth/session')).status()).toBe(200);

    const attacker = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { cookie: `core_session=${stolen}` },
    });
    await attacker.get('/api/auth/session');
    await attacker.dispose();

    // And now it is not.
    expect((await request.get('/api/auth/session')).status()).toBe(401);
  });

  test('records the detection in the audit log', async ({ request, playwright }) => {
    const email = await registerAndLogin(request, 'audit');
    const stolen = await currentToken(request);

    await ageSessionsFor(email);
    await request.get('/api/auth/session');

    const attacker = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { cookie: `core_session=${stolen}` },
    });
    await attacker.get('/api/auth/session');
    await attacker.dispose();

    const output = execLocal(
      "SELECT count(*) AS n FROM audit_log WHERE event = 'session_reuse_detected';",
    );

    expect(output).toMatch(/"n":\s*[1-9]/);
  });

  test('a random token is rejected without touching any session', async ({
    request,
    playwright,
  }) => {
    await registerAndLogin(request, 'random');

    const guesser = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { cookie: `core_session=${bytesToBase64Url(new Uint8Array(32).fill(9))}` },
    });
    expect((await guesser.get('/api/auth/session')).status()).toBe(401);
    await guesser.dispose();

    // A guessed token must not be able to sign anybody out. If it could, an
    // attacker would have a free denial-of-service against any account.
    expect((await request.get('/api/auth/session')).status()).toBe(200);
  });
});
