import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Exporting a vault in the clear.
 *
 * The gate is the feature, so the gate is what is tested. The file this
 * produces is the worst thing that can come out of the product — every
 * password, readable, in a folder nobody empties — and it must not be
 * reachable by a misclick, by a wrong password, or by anything short of
 * somebody deliberately typing a phrase that says what they are doing.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';
const PHRASE = 'export in the clear';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function makeLogin(page: Page, title: string, password: string): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function openExport(page: Page): Promise<void> {
  await page.getByTestId('open-plaintext-export').click();
  await expect(page.getByTestId('plaintext-export')).toBeVisible();
}

test.describe('plaintext export', () => {
  test.slow();

  test('says what the file is before anything else', async ({ page }) => {
    await openVault(page, 'export-warning');
    await openExport(page);

    await expect(page.getByTestId('plaintext-export')).toContainText('this file is not encrypted');
    await expect(page.getByTestId('plaintext-export')).toContainText('no way to un-export it');
  });

  test('will not run without the phrase', async ({ page }) => {
    // A misclick cannot type a sentence.
    await openVault(page, 'export-phrase-gate');
    await openExport(page);

    await expect(page.getByTestId('export-run')).toBeDisabled();

    await page.getByTestId('export-password').fill(PASSWORD);
    await expect(page.getByTestId('export-run')).toBeDisabled();

    await page.getByTestId('export-phrase').fill('yes');
    await expect(page.getByTestId('export-run')).toBeDisabled();

    await page.getByTestId('export-phrase').fill(PHRASE);
    await expect(page.getByTestId('export-run')).toBeEnabled();
  });

  test('will not run on a wrong master password', async ({ page }) => {
    // The vault is already unlocked, so this is the only thing establishing
    // that the person at the keyboard is the one who unlocked it — which may
    // have been hours ago, on a machine they have since walked away from.
    await openVault(page, 'export-password-gate');
    await openExport(page);

    await page.getByTestId('export-phrase').fill(PHRASE);
    await page.getByTestId('export-password').fill('not-the-master-password');

    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));

    await page.getByTestId('export-run').click();
    await expect(page.getByTestId('export-error')).toBeVisible({ timeout: 60_000 });
    expect(downloads).toEqual([]);
  });

  test('writes the items when both gates are passed', async ({ page }) => {
    await openVault(page, 'export-csv');
    await makeLogin(page, 'GitHub', 'a-stored-secret-value');
    await openExport(page);

    await page.getByTestId('export-phrase').fill(PHRASE);
    await page.getByTestId('export-password').fill(PASSWORD);

    const waitFor = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('export-run').click();
    const download = await waitFor;

    // Named for what it is, so it is recognisable months later in a folder full
    // of files nobody remembers making.
    expect(download.suggestedFilename()).toContain('PLAINTEXT');
    expect(download.suggestedFilename()).toMatch(/\.csv$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    expect(body).toContain('type,title,username,password');
    expect(body).toContain('GitHub');
    expect(body).toContain('a-stored-secret-value');
  });

  test('json keeps what a csv flattens', async ({ page }) => {
    await openVault(page, 'export-json');
    await makeLogin(page, 'GitHub', 'a-stored-secret-value');
    await openExport(page);

    await page.getByRole('radio', { name: /json/ }).check();
    await page.getByTestId('export-phrase').fill(PHRASE);
    await page.getByTestId('export-password').fill(PASSWORD);

    const waitFor = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('export-run').click();
    const download = await waitFor;

    expect(download.suggestedFilename()).toMatch(/\.json$/);

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      warning: string;
      items: { fields: { title: string } }[];
    };

    // The file says what it is, so a copy that has drifted away from this
    // screen still carries the warning with it.
    expect(parsed.warning).toContain('not encrypted');
    expect(parsed.items.map((item) => item.fields.title)).toContain('GitHub');
  });

  test('leaves out what was deleted', async ({ page }) => {
    // Something in the trash was deleted. An export that resurrected it into a
    // plaintext file would be the worst possible place to find that out.
    await openVault(page, 'export-trash');
    await makeLogin(page, 'Keep', 'kept-secret-value');
    await makeLogin(page, 'Bin', 'binned-secret-value');

    await page
      .getByTestId('item-row')
      .filter({ hasText: 'Bin' })
      .getByTestId('delete-item')
      .click();
    await expect(page.getByTestId('item-list')).not.toContainText('Bin');

    await openExport(page);
    await page.getByTestId('export-phrase').fill(PHRASE);
    await page.getByTestId('export-password').fill(PASSWORD);

    const waitFor = page.waitForEvent('download', { timeout: 60_000 });
    await page.getByTestId('export-run').click();
    const download = await waitFor;

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');

    expect(body).toContain('kept-secret-value');
    expect(body).not.toContain('binned-secret-value');
  });
});
