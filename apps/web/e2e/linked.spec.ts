import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Linking a vault item to an environment project.
 *
 * The database password in the vault and the `DATABASE_URL` in a project are
 * the same secret wearing two hats, and the useful thing is getting from one to
 * the other.
 *
 * The link lives inside the item's encrypted blob rather than in a join table.
 * A table would tell the operator which credential goes with which project —
 * a map of somebody's infrastructure drawn without reading a single value.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function openVault(page: Page, label: string): Promise<void> {
  await openAccount(page, label, PASSWORD);
}

async function makeProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('open-env').click();
  await expect(page).toHaveURL(/\/env/);
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-create').click();
  await expect(page.getByTestId('project-chip').filter({ hasText: name })).toBeVisible();

  await page.getByRole('button', { name: 'vault' }).click();
  await expect(page).toHaveURL(/\/vault$/);
}

async function linkItem(page: Page, title: string, project: string): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill('a-database-password');

  await page.getByTestId('item-project').click();
  await page.getByTestId('item-project-option').filter({ hasText: project }).click();

  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

test.describe('linked items', () => {
  test.slow();

  test('links a credential to a project and names it on the row', async ({ page }) => {
    await openVault(page, 'link');
    await makeProject(page, 'Checkout');
    await linkItem(page, 'Production database', 'Checkout');

    await expect(page.getByTestId('item-linked-project')).toContainText('Checkout');
  });

  test('offers no picker when there are no projects', async ({ page }) => {
    // A select with one option that says "none" is a control that does nothing.
    await openVault(page, 'link-none');

    await page.getByTestId('new-item').click();
    await expect(page.getByTestId('item-project')).toHaveCount(0);
  });

  test('opens the project from the vault', async ({ page }) => {
    await openVault(page, 'link-follow');
    await makeProject(page, 'Checkout');
    await linkItem(page, 'Production database', 'Checkout');

    await page.getByTestId('item-linked-open').click();

    await expect(page).toHaveURL(/\/env\?project=/);
    await expect(page.getByTestId('environment-tab').first()).toBeVisible();
  });

  test('keeps the vault unlocked on the way there', async ({ page }) => {
    // Client-side navigation. A full page load would drop the keys and land on
    // a locked screen a moment after leaving an unlocked vault.
    await openVault(page, 'link-unlocked');
    await makeProject(page, 'Checkout');
    await linkItem(page, 'Production database', 'Checkout');

    await page.getByTestId('item-linked-open').click();
    await expect(page.getByTestId('project-name')).toBeVisible();
  });

  test('says so when the project is gone', async ({ page }) => {
    // A link that silently vanished would look like somebody else edited the
    // item.
    await openVault(page, 'link-broken');
    await makeProject(page, 'Doomed');
    await linkItem(page, 'Production database', 'Doomed');

    await page.getByTestId('open-env').click();
    await page.getByTestId('project-delete').click();
    await page.getByRole('button', { name: 'vault' }).click();

    await expect(page.getByTestId('item-linked-project')).toContainText('not found');
  });

  test('the link never reaches the server in the clear', async ({ page }) => {
    // It is in the encrypted blob, so no request body should carry a bare id
    // next to an item id.
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'link-zk');
    await makeProject(page, 'SecretProject');
    await linkItem(page, 'Production database', 'SecretProject');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain('linkedProjectId');
  });
});
