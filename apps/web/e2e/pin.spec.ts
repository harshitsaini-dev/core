import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Quick unlock with a PIN.
 *
 * The feature is a convenience; the tests are almost entirely about its limits.
 * A PIN is short enough to guess and short enough to watch somebody type, so
 * what has to hold is the boundary around it: it cannot be set without the
 * master password, it dies after five wrong tries rather than pausing, and the
 * count survives a reload — a limit that resets when the tab closes is not a
 * limit, it is a delay.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';
const PIN = '481920';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function openPinPanel(page: Page): Promise<void> {
  await page.getByTestId('open-pin').click();
  await expect(page.getByTestId('pin-setup')).toBeVisible();
}

/** Turn quick unlock on, the only way it can be turned on. */
async function enablePin(page: Page, email: string, pin = PIN): Promise<void> {
  await openPinPanel(page);
  await page.getByTestId('pin-email').fill(email);
  await page.getByTestId('pin-password').fill(PASSWORD);
  await page.getByTestId('pin-new').fill(pin);
  await page.getByTestId('pin-confirm').fill(pin);
  await page.getByTestId('pin-save').click();
  await expect(page.getByTestId('pin-enabled')).toBeVisible({ timeout: 60_000 });
}

/** Back to a locked login screen, keys gone, storage intact. */
async function relock(page: Page): Promise<void> {
  await page.goto('/login');
}

test.describe('quick unlock', () => {
  test.slow();

  test('is off until it is turned on', async ({ page }) => {
    await openVault(page, 'pin-off');
    await openPinPanel(page);

    await expect(page.getByTestId('pin-new')).toBeVisible();
    await expect(page.getByTestId('pin-enabled')).toHaveCount(0);

    // And the login screen offers no PIN pad on a device that has none.
    await relock(page);
    await expect(page.getByTestId('pin-unlock')).toHaveCount(0);
    await expect(page.getByLabel('master password')).toBeVisible();
  });

  test('opens the vault once it is set', async ({ page }) => {
    const email = await openVault(page, 'pin-open');
    await enablePin(page, email);

    await relock(page);
    await expect(page.getByTestId('pin-unlock')).toBeVisible();
    await page.getByTestId('pin-input').fill(PIN);
    await page.getByTestId('pin-unlock-submit').click();

    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });
    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('cannot be set without the master password', async ({ page }) => {
    // The whole reason the setup form asks for it. Not a confirmation step: the
    // Account Key is held as a non-extractable key, so re-wrapping it genuinely
    // needs the Master Key derived again.
    const email = await openVault(page, 'pin-wrong-password');
    await openPinPanel(page);

    await page.getByTestId('pin-email').fill(email);
    await page.getByTestId('pin-password').fill('not-the-master-password-at-all');
    await page.getByTestId('pin-new').fill(PIN);
    await page.getByTestId('pin-confirm').fill(PIN);
    await page.getByTestId('pin-save').click();

    await expect(page.getByTestId('pin-setup-error')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('pin-enabled')).toHaveCount(0);
  });

  test('says so when the two PINs differ', async ({ page }) => {
    await openVault(page, 'pin-mismatch');
    await openPinPanel(page);

    await page.getByTestId('pin-new').fill('4444');
    await page.getByTestId('pin-confirm').fill('5555');

    await expect(page.getByTestId('pin-mismatch')).toBeVisible();
    await expect(page.getByTestId('pin-save')).toBeDisabled();
  });

  test('a wrong PIN says how many tries are left', async ({ page }) => {
    const email = await openVault(page, 'pin-wrong');
    await enablePin(page, email);
    await relock(page);

    await page.getByTestId('pin-input').fill('000000');
    await page.getByTestId('pin-unlock-submit').click();

    await expect(page.getByTestId('pin-error')).toContainText('4 tries left', { timeout: 60_000 });
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the count survives a reload', async ({ page }) => {
    // The assertion the design turns on. A counter held in the tab is a counter
    // an attacker resets by closing it, which is a delay and not a limit.
    const email = await openVault(page, 'pin-count');
    await enablePin(page, email);
    await relock(page);

    await page.getByTestId('pin-input').fill('000000');
    await page.getByTestId('pin-unlock-submit').click();
    await expect(page.getByTestId('pin-error')).toContainText('4 tries left', { timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId('pin-unlock')).toBeVisible();
    await page.getByTestId('pin-input').fill('000000');
    await page.getByTestId('pin-unlock-submit').click();

    await expect(page.getByTestId('pin-error')).toContainText('3 tries left', { timeout: 60_000 });
  });

  test('five wrong PINs delete it rather than pausing it', async ({ page }) => {
    const email = await openVault(page, 'pin-burn');
    await enablePin(page, email);
    await relock(page);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.getByTestId('pin-input').fill('000000');
      await page.getByTestId('pin-unlock-submit').click();
      if (attempt < 4) {
        await expect(page.getByTestId('pin-error')).toBeVisible({ timeout: 60_000 });
      }
    }

    // Not "locked out for a while" — gone, with the master password left as the
    // only way in. That is what makes a five-guess space acceptable at all.
    await expect(page.getByLabel('master password')).toBeVisible({ timeout: 60_000 });

    await page.reload();
    await expect(page.getByTestId('pin-unlock')).toHaveCount(0);
  });

  test('a correct PIN clears the count', async ({ page }) => {
    const email = await openVault(page, 'pin-reset-count');
    await enablePin(page, email);
    await relock(page);

    await page.getByTestId('pin-input').fill('000000');
    await page.getByTestId('pin-unlock-submit').click();
    await expect(page.getByTestId('pin-error')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('pin-input').fill(PIN);
    await page.getByTestId('pin-unlock-submit').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });

    await relock(page);
    await page.getByTestId('pin-input').fill('000000');
    await page.getByTestId('pin-unlock-submit').click();
    await expect(page.getByTestId('pin-error')).toContainText('4 tries left', { timeout: 60_000 });
  });

  test('turning it off forgets it', async ({ page }) => {
    const email = await openVault(page, 'pin-disable');
    await enablePin(page, email);

    await page.getByTestId('pin-disable').click();
    await expect(page.getByTestId('pin-new')).toBeVisible();

    await relock(page);
    await expect(page.getByTestId('pin-unlock')).toHaveCount(0);
  });

  test('the master password is always one click away', async ({ page }) => {
    // A screen that hid the real credential behind a PIN would be teaching
    // people to forget the thing that actually opens the vault.
    const email = await openVault(page, 'pin-escape');
    await enablePin(page, email);
    await relock(page);

    await page.getByTestId('use-master-password').click();
    await expect(page.getByLabel('master password')).toBeVisible();
  });

  test('the PIN never reaches the server', async ({ page }) => {
    const email = await openVault(page, 'pin-not-sent');

    const urls: string[] = [];
    const bodies: string[] = [];
    page.on('request', (request) => {
      urls.push(request.url());
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await enablePin(page, email);
    await relock(page);
    await page.getByTestId('pin-input').fill(PIN);
    await page.getByTestId('pin-unlock-submit').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });

    // The listener has to have seen something, or the two assertions below hold
    // over an empty string and mean nothing. Checked on urls rather than on
    // bodies, because the interesting outcome here is that setting a PIN and
    // unlocking with one post *no* body at all — both are local operations, and
    // the first version of this test failed on exactly that.
    expect(urls.length, 'no requests were seen, so this proves nothing').toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain(PIN);
    expect(bodies.join('\n')).not.toContain(PASSWORD);
  });
});
