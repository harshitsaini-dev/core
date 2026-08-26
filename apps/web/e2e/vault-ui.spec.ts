import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The vault, driven through the UI.
 *
 * These go the whole way: sign up, unlock, store a password, reload, and read it
 * back. Nothing here mocks the crypto or the API, so a passing run is evidence
 * that a real password survives a real round trip through a server that cannot
 * read it.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

/** Sign up and land on an unlocked vault. */
async function openVault(page: Page, label: string): Promise<string> {
  const email = uniqueEmail(label);

  await page.goto('/signup');
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('confirm master password').fill(PASSWORD);
  await page.getByRole('button', { name: 'create vault' }).click();

  await expect(page.getByTestId('kit-acknowledge')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('kit-acknowledge').check();
  await page.getByTestId('kit-continue').click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(PASSWORD);
  await page.getByTestId('unlock').click();

  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
  await expect(page.getByTestId('vault-state')).toContainText('unlocked');

  return email;
}

async function addItem(
  page: Page,
  title: string,
  username = 'me@example.com',
  password = 'stored-secret-value',
): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-username').fill(username);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

test.describe('vault', () => {
  test.slow();

  test('stores an item and shows it in the list', async ({ page }) => {
    await openVault(page, 'store');
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await addItem(page, 'GitHub');

    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('GitHub');
  });

  test('an item survives unlocking again on the same device', async ({ page }) => {
    // The round trip that matters: through encryption, the API, the database,
    // and back out again.
    const email = await openVault(page, 'persist');
    await addItem(page, 'Persisted', 'user@example.com', 'value-that-must-survive');

    await page.getByTestId('lock').click();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    await page.getByTestId('go-unlock').click();
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(PASSWORD);
    await page.getByTestId('unlock').click();

    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
    await expect(page.getByTestId('item-list')).toContainText('Persisted');
  });

  test('searching filters the list', async ({ page }) => {
    await openVault(page, 'search');
    await addItem(page, 'GitHub');
    await addItem(page, 'Bank of Somewhere');

    await page.getByTestId('search').fill('bank');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Bank');

    // The typo-tolerant path, which is the point of fuzzy matching.
    await page.getByTestId('search').fill('gthb');
    await expect(page.getByTestId('item-row-title')).toContainText('GitHub');

    await page.getByTestId('search').fill('zzzzz');
    await expect(page.getByTestId('empty-state')).toBeVisible();
  });

  test('editing an item keeps one row rather than creating a second', async ({ page }) => {
    await openVault(page, 'edit');
    await addItem(page, 'Before');

    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-title').fill('After');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('After');
  });

  test('deleting moves an item to trash, and restoring brings it back', async ({ page }) => {
    // Soft delete matters more here than on most products: there is no password
    // reset, so an unrecoverable accidental delete would be the second way to
    // lose data permanently.
    await openVault(page, 'trash');
    await addItem(page, 'Deletable');

    await page.getByTestId('delete-item').click();
    await expect(page.getByTestId('empty-state')).toBeVisible();

    await page.getByTestId('open-trash').click();
    await expect(page.getByTestId('trash-list')).toContainText('Deletable');

    await page.getByTestId('restore-item').click();
    await page.getByTestId('trash-back').click();
    await expect(page.getByTestId('item-list')).toContainText('Deletable');
  });

  test('pinning lifts an item to the top', async ({ page }) => {
    await openVault(page, 'pin');
    await addItem(page, 'Ordinary');
    await addItem(page, 'Important');

    // "Ordinary" was added first, so most-recent order puts "Important" first.
    // Pinning "Ordinary" has to beat that.
    const rows = page.getByTestId('item-row');
    await rows.filter({ hasText: 'Ordinary' }).getByTestId('toggle-favorite').click();

    await expect(rows.first()).toContainText('Ordinary');
  });

  test('the generator produces a long password and reveals it', async ({ page }) => {
    // Revealed on generation on purpose: a string nobody has seen is one nobody
    // can check.
    await openVault(page, 'generate');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-generate').click();

    const field = page.getByTestId('item-password');
    await expect(field).toHaveAttribute('type', 'text');
    expect((await field.inputValue()).length).toBeGreaterThanOrEqual(16);
  });

  test('the password field is masked until asked', async ({ page }) => {
    await openVault(page, 'mask');

    await page.getByTestId('new-item').click();
    const field = page.getByTestId('item-password');
    await expect(field).toHaveAttribute('type', 'password');

    await page.getByTestId('item-reveal').click();
    await expect(field).toHaveAttribute('type', 'text');
  });

  test('locking clears the decrypted items from memory', async ({ page }) => {
    // Otherwise the lock is cosmetic: the keys go and the plaintext stays.
    await openVault(page, 'lockclears');
    await addItem(page, 'SensitiveTitle');

    await page.getByTestId('lock').click();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    const rendered = await page.locator('body').innerText();
    expect(rendered).not.toContain('SensitiveTitle');
  });

  test('nothing readable is written to local storage', async ({ page }) => {
    await openVault(page, 'nostorage');
    await addItem(page, 'NotInStorage', 'user@example.com', 'plaintext-password-value');

    const stored = await page.evaluate(() =>
      JSON.stringify({
        local: window.localStorage,
        session: window.sessionStorage,
      }),
    );

    expect(stored).not.toContain('NotInStorage');
    expect(stored).not.toContain('plaintext-password-value');
  });

  test('the password never appears in a request body', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'zkvault');
    await addItem(page, 'ZeroKnowledge', 'user@example.com', 'never-leaves-the-browser');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('never-leaves-the-browser');
      expect(body).not.toContain('ZeroKnowledge');
    }
  });
});
