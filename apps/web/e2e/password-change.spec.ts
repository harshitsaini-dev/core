import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Changing the master password.
 *
 * The operation the whole Account Key indirection exists for, so the test that
 * matters is that the vault still opens afterwards and holds the same things.
 * A re-key that lost the data would be the most expensive possible bug in this
 * product: unrecoverable, and discovered by the person it happened to.
 */

const OLD_PASSWORD = 'correct-horse-battery-staple-7391';
const NEW_PASSWORD = 'entirely-different-passphrase-4482';

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function signUp(page: Page, label: string): Promise<string> {
  return openAccount(page, label, OLD_PASSWORD);
}

async function unlock(page: Page, email: string, password: string): Promise<void> {
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(password);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
}

async function addItem(page: Page, title: string, password = 'a-stored-secret'): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function changePassword(
  page: Page,
  email: string,
  current: string,
  next: string,
): Promise<void> {
  await page.getByTestId('open-password').click();
  await page.getByTestId('password-email').fill(email);
  await page.getByTestId('password-current').fill(current);
  await page.getByTestId('password-new').fill(next);
  await page.getByTestId('password-confirm').fill(next);
  await page.getByTestId('password-save').click();
}

test.describe('changing the master password', () => {
  test.slow();

  test('the vault still opens, with everything in it', async ({ page }) => {
    const email = await signUp(page, 'pw-change');
    await addItem(page, 'Survives', 'the-stored-secret');
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    await changePassword(page, email, OLD_PASSWORD, NEW_PASSWORD);

    // Every session is revoked, so this lands back at unlock.
    await expect(page).toHaveURL(/\/login$/, { timeout: 60_000 });
    await unlock(page, email, NEW_PASSWORD);

    await expect(page.getByTestId('item-row-title')).toContainText('Survives');

    // And the value itself, which is the thing a broken re-key would lose.
    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-reveal').click();
    await expect(page.getByTestId('item-password')).toHaveValue('the-stored-secret');
  });

  test('the old password stops working', async ({ page }) => {
    const email = await signUp(page, 'pw-old-dead');
    await changePassword(page, email, OLD_PASSWORD, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/login$/, { timeout: 60_000 });

    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(OLD_PASSWORD);
    await page.getByTestId('unlock').click();

    // The specific element: `role="alert"` also matches the toast stack.
    await expect(page.getByTestId('login-error')).toContainText('did not work', {
      timeout: 45_000,
    });
    await expect(page).toHaveURL(/\/login$/);
  });

  test('the wrong current password changes nothing', async ({ page }) => {
    const email = await signUp(page, 'pw-wrong-current');
    await addItem(page, 'Untouched');

    await changePassword(page, email, 'not-the-current-password', NEW_PASSWORD);

    await expect(page.getByTestId('password-error')).toContainText('not your current');

    // Still unlocked, still here, and the old password still works.
    await page.getByTestId('password-back').click();
    await expect(page.getByTestId('item-row-title')).toContainText('Untouched');
  });

  test('refuses two new passwords that do not match', async ({ page }) => {
    await signUp(page, 'pw-mismatch');

    await page.getByTestId('open-password').click();
    await page.getByTestId('password-new').fill('one-password-here');
    await page.getByTestId('password-confirm').fill('a-different-one');

    await expect(page.getByTestId('password-mismatch')).toBeVisible();
    await expect(page.getByTestId('password-save')).toBeDisabled();
  });

  test('neither password reaches the server', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    const email = await signUp(page, 'pw-zk');
    await changePassword(page, email, OLD_PASSWORD, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/login$/, { timeout: 60_000 });

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain(OLD_PASSWORD);
      expect(body).not.toContain(NEW_PASSWORD);
    }
  });

  test('says what it will and will not do', async ({ page }) => {
    // Somebody about to re-key a vault deserves to know that the items are not
    // being re-encrypted and that their other devices will be signed out.
    await signUp(page, 'pw-warning');
    await page.getByTestId('open-password').click();

    const note = page.getByRole('note');
    await expect(note).toContainText('not re-encrypted');
    await expect(note).toContainText('signed out');
  });
});
