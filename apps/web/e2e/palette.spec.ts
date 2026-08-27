import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The command palette and the keyboard shortcuts.
 *
 * Desktop only — a phone has no Ctrl and no Cmd, and the same screens are
 * reachable there by touch.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
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
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

  return email;
}

async function makeLogin(page: Page, title: string, password = 'a-stored-secret'): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

test.describe('command palette', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile === true, 'no modifier keys on a phone');

  test('opens with the keyboard and closes with escape', async ({ page }) => {
    await openVault(page, 'palette');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await expect(page.getByTestId('palette-input')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('palette')).toHaveCount(0);
  });

  test('finds an item and opens it', async ({ page }) => {
    await openVault(page, 'palette-find');
    await makeLogin(page, 'GitHub');
    await makeLogin(page, 'Unrelated');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('githu');

    await expect(page.getByTestId('palette-item')).toHaveCount(1);
    await page.keyboard.press('Enter');

    // Enter on an item opens it for editing rather than copying anything.
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(page.getByTestId('item-title')).toHaveValue('GitHub');
  });

  test('runs a command', async ({ page }) => {
    await openVault(page, 'palette-command');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('new item');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('item-title')).toBeVisible();
  });

  test('moves the selection with the arrow keys', async ({ page }) => {
    await openVault(page, 'palette-arrows');

    await page.keyboard.press('ControlOrMeta+k');
    const rows = page.getByTestId('palette-command');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowDown');
    await expect(rows.nth(1)).toHaveAttribute('aria-selected', 'true');

    await page.keyboard.press('ArrowUp');
    await expect(rows.first()).toHaveAttribute('aria-selected', 'true');
  });

  test('wraps around at the ends of the list', async ({ page }) => {
    await openVault(page, 'palette-wrap');

    await page.keyboard.press('ControlOrMeta+k');
    const rows = page.getByTestId('palette-command');
    const count = await rows.count();

    await page.keyboard.press('ArrowUp');
    await expect(rows.nth(count - 1)).toHaveAttribute('aria-selected', 'true');
  });

  test('says so when nothing matches', async ({ page }) => {
    await openVault(page, 'palette-empty');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('zzzzzzzz');
    await expect(page.getByTestId('palette-empty')).toBeVisible();

    // Enter on nothing must do nothing rather than run whatever was first.
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('palette')).toBeVisible();
  });

  test('never shows a stored password', async ({ page }) => {
    // The palette filters as you type, in a window somebody can read across a
    // room. Titles only.
    await openVault(page, 'palette-secret');
    await makeLogin(page, 'GitHub', 'hunter2-not-for-display');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-input').fill('github');

    await expect(page.getByTestId('palette-item')).toHaveCount(1);
    await expect(page.getByTestId('palette')).not.toContainText('hunter2-not-for-display');
  });

  test('offers nothing destructive', async ({ page }) => {
    // Fuzzy match plus a reflexive Return is exactly how an irreversible action
    // gets triggered by accident, and this product has no password reset.
    await openVault(page, 'palette-safe');

    await page.keyboard.press('ControlOrMeta+k');
    const labels = await page.getByTestId('palette-command').allInnerTexts();
    const joined = labels.join(' ').toLowerCase();

    expect(joined).not.toContain('delete');
    expect(joined).not.toContain('panic');
  });

  test('closes on a click outside', async ({ page }) => {
    await openVault(page, 'palette-click-away');

    await page.keyboard.press('ControlOrMeta+k');
    await page.getByTestId('palette-backdrop').click({ position: { x: 5, y: 5 } });
    await expect(page.getByTestId('palette')).toHaveCount(0);
  });

  test('the same chord closes it again', async ({ page }) => {
    await openVault(page, 'palette-toggle');

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette')).toHaveCount(0);
  });

  test('opens from inside a form, and locking closes it', async ({ page }) => {
    await openVault(page, 'palette-inside-form');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').click();
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByTestId('palette')).toBeVisible();

    await page.getByTestId('palette-input').fill('lock the vault');
    await page.keyboard.press('Enter');

    // The palette holds decrypted titles; locking has to take it with them.
    await expect(page.getByTestId('palette')).toHaveCount(0);
    await expect(page.getByTestId('vault-state')).toContainText('locked');
  });
});

test.describe('keyboard shortcuts', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile === true, 'no physical keyboard on a phone');

  test('n opens a new item and escape leaves it', async ({ page }) => {
    await openVault(page, 'keys-new');

    await page.keyboard.press('n');
    await expect(page.getByTestId('item-title')).toBeVisible();

    await page.getByTestId('item-title').blur();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('item-title')).toHaveCount(0);
  });

  test('slash focuses the search field', async ({ page }) => {
    await openVault(page, 'keys-search');

    await page.keyboard.press('/');
    await expect(page.getByTestId('search')).toBeFocused();
  });

  test('l locks the vault', async ({ page }) => {
    await openVault(page, 'keys-lock');

    await page.keyboard.press('l');
    await expect(page.getByTestId('vault-state')).toContainText('locked');
  });

  test('a letter typed into a field stays in the field', async ({ page }) => {
    // The reason single-letter shortcuts are gated on focus: without it, naming
    // an item "no" would open a second form halfway through.
    await openVault(page, 'keys-typing');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('');
    await page.getByTestId('item-title').press('n');
    await page.getByTestId('item-title').press('l');

    await expect(page.getByTestId('item-title')).toHaveValue('nl');
    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('a letter typed into the search box stays there', async ({ page }) => {
    await openVault(page, 'keys-typing-search');

    await page.getByTestId('search').fill('');
    await page.getByTestId('search').press('n');
    await expect(page.getByTestId('search')).toHaveValue('n');
    await expect(page.getByTestId('item-title')).toHaveCount(0);
  });
});
