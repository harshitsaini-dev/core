import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Form controls.
 *
 * Two things worth asserting, and they are different in kind. That the controls
 * *work* — a checkbox toggles, a dropdown commits a value, both from the
 * keyboard — and that they are drawn by us. The second matters because the
 * failure mode is silent: a native checkbox on a black page is a rounded blue
 * square that nobody notices in a screenshot review, but every user sees.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

/** Stops at the Emergency Kit, which is where the only checkbox lives. */
async function reachTheKit(page: Page, label: string): Promise<void> {
  await page.goto('/signup');
  await page.getByLabel('email').fill(uniqueEmail(label));
  await page.getByLabel('master password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('confirm master password').fill(PASSWORD);
  await page.getByRole('button', { name: 'create vault' }).click();
  await expect(page.getByTestId('kit-acknowledge')).toBeVisible({ timeout: 30_000 });
}

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function openVault(page: Page, label: string): Promise<void> {
  await openAccount(page, label, PASSWORD);
}

async function makeFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('open-folders').click();
  await page.getByTestId('folder-name').fill(name);
  await page.getByTestId('folder-create').click();
  await expect(page.getByTestId('folder-list')).toContainText(name);
  await page.getByTestId('folders-back').click();
}

test.describe('checkbox', () => {
  test.slow();

  test('toggles by click and by keyboard', async ({ page }) => {
    await reachTheKit(page, 'control-check');
    const box = page.getByTestId('kit-acknowledge');

    await expect(box).not.toBeChecked();
    await box.check();
    await expect(box).toBeChecked();

    // Still a real input underneath the paint, so Space still works.
    await box.press(' ');
    await expect(box).not.toBeChecked();
  });

  test('is drawn by us, not by the platform', async ({ page }) => {
    await reachTheKit(page, 'control-check-paint');

    const style = await page.getByTestId('kit-acknowledge').evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        appearance: computed.appearance,
        radius: computed.borderTopLeftRadius,
        accent: computed.accentColor,
        background: computed.backgroundColor,
      };
    });

    expect(style.appearance).toBe('none');
    // The zero-radius rule, which is the one the platform breaks first.
    expect(style.radius).toBe('0px');
    expect(style.background).toBe('rgb(0, 0, 0)');
  });

  test('marks itself in the accent colour when checked', async ({ page }) => {
    await reachTheKit(page, 'control-check-mark');
    const box = page.getByTestId('kit-acknowledge');

    const markScale = async (): Promise<string> =>
      box.evaluate((element) => getComputedStyle(element, '::after').transform);

    const resting = await markScale();
    await box.check();

    // The mark scales in rather than appearing, so the box does not resize.
    await expect.poll(markScale).not.toBe(resting);

    const border = await box.evaluate((element) => getComputedStyle(element).borderTopColor);
    expect(border).toBe('rgb(0, 255, 65)');
  });

  test('the label is part of the target', async ({ page }) => {
    // A 17px box is a poor tap target; the sentence beside it is not.
    await reachTheKit(page, 'control-check-label');

    await page.getByText('I have stored this recovery key').click();
    await expect(page.getByTestId('kit-acknowledge')).toBeChecked();
  });
});

test.describe('dropdown', () => {
  test.slow();

  test('opens, picks, and closes', async ({ page }) => {
    await openVault(page, 'control-select');
    await makeFolder(page, 'Work');

    await page.getByTestId('new-item').click();
    const trigger = page.getByTestId('item-folder');

    await expect(trigger).toContainText('no folder');
    await trigger.click();
    await expect(page.getByTestId('item-folder-list')).toBeVisible();

    await page.getByTestId('item-folder-option').filter({ hasText: 'Work' }).click();

    await expect(page.getByTestId('item-folder-list')).toHaveCount(0);
    await expect(trigger).toContainText('Work');
  });

  test('is a listbox, not a native select', async ({ page }) => {
    // The whole reason this component exists: a native popup is drawn by the OS
    // and lands as a white menu in the middle of a black terminal.
    await openVault(page, 'control-select-native');
    await page.getByTestId('new-item').click();

    const tag = await page.getByTestId('item-folder').evaluate((element) => element.tagName);
    expect(tag).toBe('BUTTON');
    await expect(page.getByTestId('item-folder')).toHaveAttribute('role', 'combobox');
    expect(await page.locator('select').count()).toBe(0);
  });

  test('works from the keyboard alone', async ({ page }) => {
    await openVault(page, 'control-select-keys');
    await makeFolder(page, 'Work');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-folder').focus();

    await page.keyboard.press('Enter');
    await expect(page.getByTestId('item-folder-list')).toBeVisible();

    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('item-folder')).toContainText('Work');
  });

  test('escape closes it without changing anything', async ({ page }) => {
    await openVault(page, 'control-select-escape');
    await makeFolder(page, 'Work');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-folder').focus();

    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');

    await expect(page.getByTestId('item-folder-list')).toHaveCount(0);
    await expect(page.getByTestId('item-folder')).toContainText('no folder');
  });

  test('typing a letter jumps to that option', async ({ page }) => {
    await openVault(page, 'control-select-typeahead');
    await makeFolder(page, 'Work');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-folder').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('w');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('item-folder')).toContainText('Work');
  });

  test('clicking away closes it', async ({ page }) => {
    await openVault(page, 'control-select-outside');
    await page.getByTestId('new-item').click();

    await page.getByTestId('item-folder').click();
    await expect(page.getByTestId('item-folder-list')).toBeVisible();

    await page.getByTestId('item-title').click();
    await expect(page.getByTestId('item-folder-list')).toHaveCount(0);
  });

  test('opens on the current value rather than the top', async ({ page }) => {
    // A list of thirty folders that always opens at the first one makes the
    // chosen one hard to find.
    await openVault(page, 'control-select-position');
    await makeFolder(page, 'Work');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-folder').click();
    await page.getByTestId('item-folder-option').filter({ hasText: 'Work' }).click();

    await page.getByTestId('item-folder').click();
    await expect(
      page.getByTestId('item-folder-option').filter({ hasText: 'Work' }),
    ).toHaveAttribute('data-active', 'true');
  });

  test('is square and black like everything else', async ({ page }) => {
    await openVault(page, 'control-select-theme');
    await page.getByTestId('new-item').click();

    const style = await page.getByTestId('item-folder').evaluate((element) => {
      const computed = getComputedStyle(element);
      return { radius: computed.borderTopLeftRadius, background: computed.backgroundColor };
    });

    expect(style.radius).toBe('0px');
    expect(style.background).toBe('rgb(0, 0, 0)');
  });
});

test.describe('textarea', () => {
  test.slow();

  test('is bordered and square, and lights on focus', async ({ page }) => {
    await openVault(page, 'control-textarea');
    await page.getByTestId('new-item').click();
    await page.getByTestId('type-note').click();

    const body = page.getByTestId('note-body');
    const radius = await body.evaluate((element) => getComputedStyle(element).borderTopLeftRadius);
    expect(radius).toBe('0px');

    await body.click();
    await expect
      .poll(() => body.evaluate((element) => getComputedStyle(element).borderTopColor))
      .toBe('rgb(0, 255, 65)');
  });
});

test.describe('browser chrome on inputs', () => {
  test.slow();

  test('the search field clears with our button, not the browser’s', async ({ page }) => {
    // The native cancel button is hidden because it is drawn grey on a black
    // field. Hiding it without replacing it would have been a straight loss.
    await openVault(page, 'control-search-clear');

    await expect(page.getByTestId('clear-search')).toHaveCount(0);

    await page.getByTestId('search').fill('anything');
    await page.getByTestId('clear-search').click();

    await expect(page.getByTestId('search')).toHaveValue('');
    await expect(page.getByTestId('search')).toBeFocused();
  });

  test('the password field has one reveal control, not two', async ({ page }) => {
    await openVault(page, 'control-password-reveal');
    await page.getByTestId('new-item').click();

    const field = page.getByTestId('item-password');
    await field.fill('secret');
    await expect(field).toHaveAttribute('type', 'password');

    const nativeWidth = await field.evaluate((element) => {
      const style = getComputedStyle(element, '::-ms-reveal');
      return style.display;
    });
    expect(nativeWidth === 'none' || nativeWidth === '').toBeTruthy();

    await page.getByTestId('item-reveal').click();
    await expect(field).toHaveAttribute('type', 'text');
  });
});
