import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Folders and tags, through the browser.
 *
 * The sync tests cover what the server enforces. These cover the half it
 * cannot: the tree is assembled, filtered and rendered here, from names only
 * this device can read.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

async function unlock(page: Page, email: string): Promise<void> {
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
}

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
  await unlock(page, email);

  return email;
}

/**
 * Pick an option from one of our dropdowns.
 *
 * `selectOption` does not apply: these are listboxes, not `<select>` elements —
 * a native popup is drawn by the OS and cannot be themed.
 */
async function choose(page: Page, testId: string, label: string): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByTestId(`${testId}-option`).filter({ hasText: label }).first().click();
  await expect(page.getByTestId(testId)).toContainText(label);
}

async function makeFolder(page: Page, name: string, parent?: string): Promise<void> {
  await page.getByTestId('open-folders').click();
  await page.getByTestId('folder-name').fill(name);
  if (parent) await choose(page, 'folder-parent', parent);
  await page.getByTestId('folder-create').click();
  await expect(page.getByTestId('folder-list')).toContainText(name);
  await page.getByTestId('folders-back').click();
}

async function makeLogin(
  page: Page,
  title: string,
  options: { folder?: string; tags?: string } = {},
): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  if (options.folder) {
    await choose(page, 'item-folder', options.folder);
  }
  if (options.tags) await page.getByTestId('item-tags').fill(options.tags);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

test.describe('folders', () => {
  test.slow();

  test('creates a folder and files an item in it', async ({ page }) => {
    await openVault(page, 'ui-folder');
    await makeFolder(page, 'Work');
    await makeLogin(page, 'Payroll', { folder: 'Work' });

    await page.getByTestId('folder-chip').click();
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Payroll');
  });

  test('separates filed items from unfiled ones', async ({ page }) => {
    await openVault(page, 'ui-unfiled');
    await makeFolder(page, 'Work');
    await makeLogin(page, 'Payroll', { folder: 'Work' });
    await makeLogin(page, 'Loose');

    await page.getByTestId('folder-none').click();
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Loose');

    await page.getByTestId('folder-all').click();
    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });

  test('shows a nested folder under its parent', async ({ page }) => {
    await openVault(page, 'ui-nested');
    await makeFolder(page, 'Work');
    await makeFolder(page, 'Clients', 'Work');

    await page.getByTestId('open-folders').click();
    const rows = page.getByTestId('folder-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Work');
    await expect(rows.nth(1)).toContainText('Clients');
  });

  test('counts what is inside a folder before it is deleted', async ({ page }) => {
    await openVault(page, 'ui-count');
    await makeFolder(page, 'Work');
    await makeLogin(page, 'Payroll', { folder: 'Work' });

    await page.getByTestId('open-folders').click();
    await expect(page.getByTestId('folder-row')).toContainText('(1)');
  });

  test('deleting a folder keeps its items and drops the filter', async ({ page }) => {
    await openVault(page, 'ui-folder-delete');
    await makeFolder(page, 'Temporary');
    await makeLogin(page, 'Survivor', { folder: 'Temporary' });

    await page.getByTestId('folder-chip').click();
    await expect(page.getByTestId('item-row')).toHaveCount(1);

    await page.getByTestId('open-folders').click();
    await page.getByTestId('folder-delete').click();
    await page.getByTestId('folders-back').click();

    // The filter fell away with the folder rather than leaving an empty vault
    // with no visible way back.
    await expect(page.getByTestId('folder-chip')).toHaveCount(0);
    await expect(page.getByTestId('item-row-title')).toContainText('Survivor');
  });

  test('survives locking and unlocking again', async ({ page }) => {
    // A reload drops the keys with the tab, by design — so the folder has to
    // come back through the same path everything else does: decrypted from the
    // cache or the server once the master password is entered again.
    const email = await openVault(page, 'ui-folder-reload');
    await makeFolder(page, 'Persistent');
    await makeLogin(page, 'Filed', { folder: 'Persistent' });
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    await page.getByTestId('lock').click();
    await page.getByTestId('go-unlock').click();
    await unlock(page, email);

    await expect(page.getByTestId('folder-chip')).toContainText('Persistent', {
      timeout: 30_000,
    });

    await page.getByTestId('folder-chip').click();
    await expect(page.getByTestId('item-row-title')).toContainText('Filed');
  });

  test('the folder name never reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'ui-folder-zk');
    await makeFolder(page, 'OffshoreAccounts');
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain('OffshoreAccounts');
  });

  test('no filter row is shown until there is something to filter by', async ({ page }) => {
    await openVault(page, 'ui-no-filters');
    await expect(page.getByTestId('filters')).toHaveCount(0);
  });
});

test.describe('tags', () => {
  test.slow();

  test('tags an item and filters by it', async ({ page }) => {
    await openVault(page, 'ui-tags');
    await makeLogin(page, 'Payroll', { tags: 'work, finance' });
    await makeLogin(page, 'Unrelated');

    await expect(page.getByTestId('tag-chip')).toHaveCount(2);
    await page.getByTestId('tag-chip').filter({ hasText: 'work' }).click();

    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Payroll');
  });

  test('clicking the same tag again clears the filter', async ({ page }) => {
    await openVault(page, 'ui-tags-toggle');
    await makeLogin(page, 'Payroll', { tags: 'work' });
    await makeLogin(page, 'Unrelated');

    const chip = page.getByTestId('tag-chip').filter({ hasText: 'work' });
    await chip.click();
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await chip.click();
    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });

  test('deduplicates a tag entered twice', async ({ page }) => {
    await openVault(page, 'ui-tags-dedupe');
    await makeLogin(page, 'Payroll', { tags: 'work, work,  work ' });

    await expect(page.getByTestId('tag-chip')).toHaveCount(1);
    await expect(page.getByTestId('item-row-tags')).toHaveText('#work');
  });

  test('combines with a folder rather than replacing it', async ({ page }) => {
    // Folders and tags answer different questions, so applying both should
    // narrow twice — not have the second silently discard the first.
    await openVault(page, 'ui-tags-and-folder');
    await makeFolder(page, 'Work');
    await makeLogin(page, 'Payroll', { folder: 'Work', tags: 'finance' });
    await makeLogin(page, 'Rota', { folder: 'Work' });
    await makeLogin(page, 'Bank', { tags: 'finance' });

    await page.getByTestId('folder-chip').click();
    await page.getByTestId('tag-chip').filter({ hasText: 'finance' }).click();

    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Payroll');
  });

  test('search runs inside the current filter', async ({ page }) => {
    await openVault(page, 'ui-tags-search');
    await makeLogin(page, 'Payroll', { tags: 'work' });
    await makeLogin(page, 'Payments');

    await page.getByTestId('tag-chip').filter({ hasText: 'work' }).click();
    await page.getByTestId('search').fill('pay');

    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Payroll');
  });

  test('a tag disappears when the last item carrying it does', async ({ page }) => {
    await openVault(page, 'ui-tags-gone');
    await makeLogin(page, 'Payroll', { tags: 'work' });
    await expect(page.getByTestId('tag-chip')).toHaveCount(1);

    await page.getByTestId('delete-item').click();
    await expect(page.getByTestId('tag-chip')).toHaveCount(0);
  });

  test('the tag never reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'ui-tags-zk');
    await makeLogin(page, 'Payroll', { tags: 'divorce-lawyer' });
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain('divorce-lawyer');
  });
});
