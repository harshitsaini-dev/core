import { expect, test } from '@playwright/test';
import { buildAccount, uniqueEmail } from './helpers/account';

/**
 * What the login screen does with each kind of refusal.
 *
 * The offline fallback used to rethrow one error and treat everything else as
 * an unreachable server. That was right until there was more than one thing a
 * sign-in could answer — and then a browser that needed an email code fell into
 * the offline path, where a device with nothing stored reported a failed
 * sign-in, and the screen said the credentials were wrong. The code had already
 * been sent; there was nowhere to type it.
 *
 * Email is off in this environment, so the code path itself cannot be driven
 * from here. What is driven is the branch that mattered: a genuine rejection
 * must not be reported as an offline problem, and must not silently fall
 * through to a local unlock.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

test.describe('sign-in refusals', () => {
  test.slow();

  test('a wrong password says so, and does not try the local copy', async ({ page, request }) => {
    const account = await buildAccount(uniqueEmail('device-ui'), PASSWORD);
    expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);

    await page.goto('/login');
    await page.getByLabel('email').fill(account.payload.email);
    await page.getByLabel('master password').fill('not-the-master-password');
    await page.getByTestId('unlock').click();

    await expect(page.getByTestId('login-error')).toContainText('did not work', {
      timeout: 60_000,
    });

    // Never reaches the vault, and never says it is offline about a server that
    // answered.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByTestId('login-error')).not.toContainText('connection');
  });

  test('a correct password on a fresh browser reaches the vault', async ({ page, request }) => {
    // The guard on the whole feature: with email off, nothing may stand between
    // a correct password and the vault.
    const account = await buildAccount(uniqueEmail('device-ui-ok'), PASSWORD);
    expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);

    await page.goto('/login');
    await page.getByLabel('email').fill(account.payload.email);
    await page.getByLabel('master password').fill(PASSWORD);
    await page.getByTestId('unlock').click();

    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });
  });
});
