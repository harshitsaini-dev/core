import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';
import { openPanel } from './helpers/vault-nav';

/**
 * Backup and restore.
 *
 * A vault nobody can get their data out of is a vault nobody should put data
 * into, so the test that matters is not "a file downloads" — it is that the file
 * opens a vault back up in a *different* account, which is the situation a
 * backup exists for.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';
const OTHER_PASSWORD = 'entirely-different-passphrase-4482';

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function signUp(page: Page, label: string, password = PASSWORD): Promise<string> {
  return openAccount(page, label, password);
}

async function addItem(page: Page, title: string, password = 'a-stored-secret'): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

/** Download a backup and hand back its text. */
async function takeBackup(page: Page): Promise<string> {
  await openPanel(page, 'open-backup');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('backup-download').click(),
  ]);

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);

  return Buffer.concat(chunks).toString('utf8');
}

async function restoreInto(page: Page, text: string, password: string): Promise<void> {
  await openPanel(page, 'open-backup');
  await page.getByTestId('backup-file').setInputFiles({
    name: 'core-backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  });

  await expect(page.getByTestId('backup-summary')).toBeVisible();
  await page.getByTestId('backup-password').fill(password);
  await page.getByTestId('backup-restore').click();
}

test.describe('backup', () => {
  test.slow();

  test('downloads a file that holds no readable secret', async ({ page }) => {
    await signUp(page, 'backup-opaque');
    await addItem(page, 'GitHub', 'never-in-the-file');

    const text = await takeBackup(page);

    expect(text).toContain('core.backup.v1');
    expect(text).not.toContain('never-in-the-file');
    expect(text).not.toContain('GitHub');
  });

  test('carries the material needed to open it without the service', async ({ page }) => {
    // A backup that needs the running server to read is not a backup of
    // anything.
    await signUp(page, 'backup-material');
    await addItem(page, 'GitHub');

    const backup = JSON.parse(await takeBackup(page)) as Record<string, unknown>;

    expect(backup).toHaveProperty('accountKeyWrapped');
    expect(backup).toHaveProperty('kdf');
    expect(Array.isArray(backup.items)).toBe(true);
  });

  test('restores into a different account, which is the point', async ({ page, browser }) => {
    await signUp(page, 'backup-source');
    await addItem(page, 'Recovered login', 'the-original-secret');
    const text = await takeBackup(page);

    // A second account, a second browser, a different master password: the
    // situation on the day the first account is gone.
    const context = await browser.newContext();
    const fresh = await context.newPage();
    await signUp(fresh, 'backup-target', OTHER_PASSWORD);

    await restoreInto(fresh, text, PASSWORD);

    // If the restore reported a problem, say what it was rather than timing out
    // on a row that was never going to appear.
    // The toast is what the restore reports, and waiting for it is what stops
    // the next assertion racing a push that is still in flight.
    // Waiting for the report, not just for a row: without it this races a push
    // still in flight, and a restore that reported "1 item" while doing nothing
    // is exactly the failure this test caught the first time it ran.
    await expect(fresh.getByTestId('toast')).toContainText('Restored 1 item');

    await expect(fresh.getByTestId('item-row-title')).toContainText('Recovered login');

    // And the value came with it, re-encrypted under the new account's key.
    await fresh.getByTestId('edit-item').click();
    await fresh.getByTestId('item-reveal').click();
    await expect(fresh.getByTestId('item-password')).toHaveValue('the-original-secret');

    await context.close();
  });

  test('refuses the wrong master password and changes nothing', async ({ page, browser }) => {
    await signUp(page, 'backup-wrong-source');
    await addItem(page, 'Should not arrive');
    const text = await takeBackup(page);

    const context = await browser.newContext();
    const fresh = await context.newPage();
    await signUp(fresh, 'backup-wrong-target', OTHER_PASSWORD);

    await restoreInto(fresh, text, 'not-the-right-password-at-all');

    await expect(fresh.getByTestId('backup-error')).toContainText('does not open this backup');
    await fresh.getByTestId('backup-back').click();
    await expect(fresh.getByTestId('item-row')).toHaveCount(0);

    await context.close();
  });

  test('adds without removing', async ({ page }) => {
    // "Restore the two items I lost" must not mean "replace everything with a
    // file from March".
    const email = await signUp(page, 'backup-additive');
    await addItem(page, 'In the backup');
    const text = await takeBackup(page);
    await page.getByTestId('backup-back').click();

    await addItem(page, 'Added afterwards');

    await restoreInto(page, text, PASSWORD);

    await expect(page.getByTestId('item-row')).toHaveCount(2);
    await expect(page.getByTestId('item-list')).toContainText('Added afterwards');
    expect(email).toBeTruthy();
  });

  test('says what a file is before doing anything with it', async ({ page }) => {
    await signUp(page, 'backup-summary');
    await addItem(page, 'One');
    const text = await takeBackup(page);
    await page.getByTestId('backup-back').click();

    await openPanel(page, 'open-backup');
    await page.getByTestId('backup-file').setInputFiles({
      name: 'core-backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(text, 'utf8'),
    });

    await expect(page.getByTestId('backup-summary')).toContainText('1 item(s)');
  });

  test('explains a file that is not a backup', async ({ page }) => {
    // "Import failed" helps nobody standing in front of a vault they cannot
    // open.
    await signUp(page, 'backup-garbage');

    await openPanel(page, 'open-backup');
    await page.getByTestId('backup-file').setInputFiles({
      name: 'holiday.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('this is not a backup', 'utf8'),
    });

    await expect(page.getByTestId('backup-summary')).toContainText('not even JSON');
  });

  test('warns what the file is worth', async ({ page }) => {
    await signUp(page, 'backup-warning');
    await openPanel(page, 'open-backup');

    await expect(page.getByRole('note')).toContainText('master password');
  });
});

test('a restore into a fresh account renumbers what it writes', async ({ page, browser }) => {
  /*
   * Ids are globally unique keys, not per-account ones. A backup carries the
   * ids of the account it came from, so restoring into a different account
   * while the original rows still exist means every insert collides with a row
   * somebody else owns — and the server, correctly, refuses to touch it and
   * says nothing.
   *
   * The first version of this feature did exactly that: reported "restored 1
   * item" and wrote none. Silence on the one day the feature matters.
   */
  test.slow();

  await signUp(page, 'renumber-source');
  await addItem(page, 'Original');

  const text = await takeBackup(page);
  const backup = JSON.parse(text) as { items: { id: string }[] };
  const originalId = backup.items[0]?.id;
  expect(originalId).toBeTruthy();

  const context = await browser.newContext();
  const fresh = await context.newPage();
  await signUp(fresh, 'renumber-target', OTHER_PASSWORD);
  await restoreInto(fresh, text, PASSWORD);

  await expect(fresh.getByTestId('item-row-title')).toContainText('Original');

  // And the row it wrote is a new row, not the one the other account owns.
  const written = await fresh.evaluate(async () => {
    const response = await fetch('/api/vault/sync?since=0', { credentials: 'same-origin' });
    return ((await response.json()) as { items: { id: string }[] }).items.map((row) => row.id);
  });

  expect(written).toHaveLength(1);
  expect(written[0]).not.toBe(originalId);

  await context.close();
});
