import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Importing a CSV from another password manager.
 *
 * What it reads is somebody's entire vault, exported in the clear. Every row it
 * drops is a password they will not discover is missing until they need it, so
 * these are mostly about not losing rows and about the mapping being visible
 * before anything is stored.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

async function openVault(page: Page, label: string): Promise<void> {
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
}

async function choose(page: Page, csv: string): Promise<void> {
  await page.getByTestId('open-csv-import').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'export.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
}

const BITWARDEN =
  'folder,favorite,type,name,notes,fields,login_uri,login_username,login_password,login_totp\n' +
  ',,login,GitHub,a note,,https://github.com,me@example.com,gh-secret,\n' +
  ',,login,Bank,"multi\nline note",,https://bank.example,me,bank-secret,\n';

test.describe('csv import', () => {
  test.slow();

  test('reads a Bitwarden export and maps its columns', async ({ page }) => {
    await openVault(page, 'csv-bitwarden');
    await choose(page, BITWARDEN);

    await expect(page.getByTestId('import-summary')).toContainText('2 row(s)');
    await expect(page.getByTestId('import-map-title')).toContainText('name');
    await expect(page.getByTestId('import-map-password')).toContainText('login_password');
  });

  test('imports the rows', async ({ page }) => {
    await openVault(page, 'csv-import');
    await choose(page, BITWARDEN);

    await page.getByTestId('import-run').click();

    await expect(page.getByTestId('item-row')).toHaveCount(2);
    await expect(page.getByTestId('item-list')).toContainText('GitHub');
    await expect(page.getByTestId('item-list')).toContainText('Bank');
  });

  test('keeps a multi-line note in one item', async ({ page }) => {
    // Splitting the file on newlines would turn this row into two broken ones.
    await openVault(page, 'csv-multiline');
    await choose(page, BITWARDEN);
    await page.getByTestId('import-run').click();

    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });

  test('brings the password across', async ({ page }) => {
    await openVault(page, 'csv-password');
    await choose(page, BITWARDEN);
    await page.getByTestId('import-run').click();

    await page.getByTestId('search').fill('GitHub');
    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-reveal').click();

    await expect(page.getByTestId('item-password')).toHaveValue('gh-secret');
  });

  test('shows the mapping before anything is stored, and it can be changed', async ({ page }) => {
    // Getting username and email the wrong way round is invisible afterwards
    // and annoying for years.
    await openVault(page, 'csv-mapping');
    await choose(page, 'name,password,url\nGitHub,secret,https://github.com\n');

    await page.getByTestId('import-map-username').click();
    await page.getByTestId('import-map-username-option').filter({ hasText: 'url' }).click();

    await expect(page.getByTestId('import-preview')).toContainText('https://github.com');
  });

  test('says when a file has a header and nothing else', async ({ page }) => {
    await openVault(page, 'csv-empty');
    await choose(page, 'name,password\n');

    await expect(page.getByTestId('import-empty')).toBeVisible();
  });

  test('refuses a file it cannot map', async ({ page }) => {
    await openVault(page, 'csv-unmappable');
    await choose(page, 'col1,col2\nfoo,bar\n');

    await expect(page.getByTestId('import-run')).toBeDisabled();
  });

  test('warns that the file on disk is plaintext', async ({ page }) => {
    // The export they just made needs no password at all, and saying so is the
    // only part of this flow that protects them afterwards.
    await openVault(page, 'csv-warning');
    await page.getByTestId('open-csv-import').click();

    await expect(page.getByRole('note')).toContainText('unencrypted');
  });

  test('nothing from the file reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'csv-zk');
    await choose(page, BITWARDEN);
    await page.getByTestId('import-run').click();
    await expect(page.getByTestId('item-row')).toHaveCount(2);

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('gh-secret');
      expect(body).not.toContain('GitHub');
    }
  });
});
