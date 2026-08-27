import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Which key-derivation parameters a build actually ships.
 *
 * The suite runs with `NEXT_PUBLIC_TEST_KDF=1`, which replaces calibration with
 * fixed, weak parameters so several browsers can run Argon2id at once without
 * starving the machine. That flag is the kind of thing that quietly survives
 * into a real build, and nothing else in the suite would notice: every
 * assertion about encryption still passes with a cheap KDF, because the
 * algorithm and the envelope are unchanged. Only the cost is different, and
 * cost is the entire defence against an offline attack on a stolen database.
 *
 * So this asserts the parameters match the environment the build was made in,
 * in both directions.
 */

/**
 * Read the flag from the file the app reads it from.
 *
 * Not from this process's environment: `.env.local` is loaded by Next, inside
 * the server, and never reaches the test runner. Asking the runner produced a
 * test that expected a production build while driving a test one.
 */
function testKdfEnabled(): boolean {
  const file = resolve(dirname(fileURLToPath(import.meta.url)), '../../../apps/web/.env.local');
  if (!existsSync(file)) return false;
  return /^NEXT_PUBLIC_TEST_KDF=1$/m.test(readFileSync(file, 'utf8'));
}

const testKdf = testKdfEnabled();

test('the shipped KDF parameters match the build', async ({ page, isMobile }) => {
  test.slow();
  // A build property, not a viewport one.
  test.skip(isMobile === true, 'nothing here depends on the screen');

  let sent: { memoryKiB: number; iterations: number } | null = null;

  page.on('request', (request) => {
    if (!request.url().endsWith('/api/auth/signup')) return;
    const body = request.postData();
    if (!body) return;
    sent = (JSON.parse(body) as { kdfParams: typeof sent }).kdfParams;
  });

  await page.goto('/signup');
  await page.getByLabel('email').fill(`kdf-${crypto.randomUUID()}@core.test`);
  await page.getByLabel('master password', { exact: true }).fill('correct-horse-battery-7391');
  await page.getByLabel('confirm master password').fill('correct-horse-battery-7391');
  await page.getByRole('button', { name: 'create vault' }).click();

  await expect(page.getByTestId('kit-acknowledge')).toBeVisible({ timeout: 60_000 });
  expect(sent, 'no signup request was observed').not.toBeNull();

  const params = sent as unknown as { memoryKiB: number; iterations: number };

  if (testKdf) {
    // Exactly the cheap ones, so a build that silently started calibrating
    // would fail here rather than quietly costing the suite an hour.
    expect(params.memoryKiB).toBe(8192);
    expect(params.iterations).toBe(1);
  } else {
    // A real build: 64 MiB, and calibrated to more than a single pass.
    expect(params.memoryKiB).toBe(65_536);
    expect(params.iterations).toBeGreaterThan(1);
  }
});
