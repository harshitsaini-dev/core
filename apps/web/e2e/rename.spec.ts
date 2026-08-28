import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Renaming an item from the list.
 *
 * The edit people actually do in passing, and the one worth not opening a form
 * for. The tests that matter are the ones about its edges: an empty title is a
 * row nobody can find again, a cancel has to leave the old one alone, and the
 * field must not become a place secrets get typed.
 *
 * Desktop only, and honestly so. The trigger is a double-click, which a touch
 * screen does not produce — and on a phone an inline field sits under a
 * keyboard covering half the list, while the edit button is one tap away and
 * opens a form whose first field is the title. `features.md` says desktop for
 * the same reason.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function makeLogin(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill('a-stored-secret-value');
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function startRename(page: Page): Promise<void> {
  await page.getByTestId('item-row-title').first().dblclick();
  await expect(page.getByTestId('rename-input')).toBeVisible();
}

test.describe('renaming from the list', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile === true, 'a double-click is not a touch gesture');

  test('a double-click opens the field with the title selected', async ({ page }) => {
    await openVault(page, 'rename-open');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await expect(page.getByTestId('rename-input')).toHaveValue('GitHub');
  });

  test('enter saves it', async ({ page }) => {
    await openVault(page, 'rename-save');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await page.getByTestId('rename-input').fill('GitHub work');
    await page.getByTestId('rename-input').press('Enter');

    await expect(page.getByTestId('rename-input')).toHaveCount(0);
    await expect(page.getByTestId('item-list')).toContainText('GitHub work');
  });

  test('the new title survives a reload', async ({ page }) => {
    // Renamed in the list, not in the form, so this is the assertion that the
    // change actually reached the vault rather than only the screen.
    const email = await openVault(page, 'rename-persist');
    await makeLogin(page, 'GitHub');
    await startRename(page);
    await page.getByTestId('rename-input').fill('GitHub work');
    await page.getByTestId('rename-input').press('Enter');
    await expect(page.getByTestId('item-list')).toContainText('GitHub work');
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    await page.goto('/login');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(PASSWORD);
    await page.getByTestId('unlock').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await expect(page.getByTestId('item-list')).toContainText('GitHub work');
    await expect(page.getByTestId('item-list')).not.toContainText('GitHub work extra');
  });

  test('escape cancels without saving', async ({ page }) => {
    // What this checks is the cancel, and only the cancel. It was written
    // believing it also covered Escape not reaching the vault's own handler and
    // closing the screen behind the field; it does not, and cannot — the list
    // is already the screen behind it.
    await openVault(page, 'rename-escape');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await page.getByTestId('rename-input').fill('Something else entirely');
    await page.getByTestId('rename-input').press('Escape');

    await expect(page.getByTestId('rename-input')).toHaveCount(0);
    await expect(page.getByTestId('item-list')).toContainText('GitHub');
    await expect(page.getByTestId('item-list')).not.toContainText('Something else entirely');
  });

  test('an empty title is treated as a cancel', async ({ page }) => {
    // A row with no title is a row nobody can find again, and nobody means it.
    await openVault(page, 'rename-empty');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await page.getByTestId('rename-input').fill('   ');
    await page.getByTestId('rename-input').press('Enter');

    await expect(page.getByTestId('item-list')).toContainText('GitHub');
  });

  test('clicking away saves', async ({ page }) => {
    await openVault(page, 'rename-blur');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await page.getByTestId('rename-input').fill('GitHub personal');
    await page.getByTestId('rename-input').blur();

    await expect(page.getByTestId('item-list')).toContainText('GitHub personal');
  });

  test('typing in the field does not trigger a shortcut', async ({ page }) => {
    // `n` opens a new item and `l` locks the vault. A rename field that let
    // those through would lock the vault halfway through naming something
    // "personal".
    await openVault(page, 'rename-typing');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await page.getByTestId('rename-input').fill('');
    await page.getByTestId('rename-input').press('n');
    await page.getByTestId('rename-input').press('l');

    await expect(page.getByTestId('rename-input')).toHaveValue('nl');
    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('renames the row it was opened on', async ({ page }) => {
    await openVault(page, 'rename-right-row');
    await makeLogin(page, 'Alpha');
    await makeLogin(page, 'Beta');

    await page.getByTestId('item-row-title').nth(1).dblclick();
    await expect(page.getByTestId('rename-input')).toBeVisible();
    await page.getByTestId('rename-input').fill('Renamed');
    await page.getByTestId('rename-input').press('Enter');

    const titles = await page.getByTestId('item-row-title').allInnerTexts();
    expect(titles).toContain('Renamed');
    expect(titles).toHaveLength(2);
  });

  test('offers no inline field for anything but the title', async ({ page }) => {
    // Deliberate. Blur-all cannot cover a field somebody is typing into, so an
    // inline password would put a hole in the one control that exists for
    // "someone is looking at my screen", exactly where the password is.
    await openVault(page, 'rename-title-only');
    await makeLogin(page, 'GitHub');
    await startRename(page);

    await expect(page.getByTestId('rename-input')).toHaveCount(1);
    await expect(page.locator('input[type="password"]')).toHaveCount(0);
  });
});
