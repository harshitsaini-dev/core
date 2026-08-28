import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * The grid/list toggle and bulk selection.
 *
 * Bulk actions are the easiest way in this product to change a lot by accident,
 * so most of what is asserted here is about restraint: that a tag is added
 * rather than replacing what was there, that a delete offers a way back, and
 * that turning on selection turns off the gesture that copies a password.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function unlock(page: Page, email: string): Promise<void> {
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
}

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function makeLogin(
  page: Page,
  title: string,
  fields: { password?: string; tags?: string } = {},
): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  if (fields.password) await page.getByTestId('item-password').fill(fields.password);
  if (fields.tags) await page.getByTestId('item-tags').fill(fields.tags);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function makeFolder(page: Page, name: string): Promise<void> {
  await page.getByTestId('open-folders').click();
  await page.getByTestId('folder-name').fill(name);
  await page.getByTestId('folder-create').click();
  await expect(page.getByTestId('folder-list')).toContainText(name);
  await page.getByTestId('folders-back').click();
}

test.describe('layout', () => {
  test.slow();

  test('switches between a list and a grid', async ({ page }) => {
    await openVault(page, 'layout');
    await makeLogin(page, 'GitHub');

    await expect(page.getByTestId('item-list')).toHaveAttribute('data-layout', 'list');
    await page.getByTestId('toggle-layout').click();
    await expect(page.getByTestId('item-list')).toHaveAttribute('data-layout', 'grid');
  });

  test('remembers the choice across a reload', async ({ page }) => {
    // The one preference worth writing down. It holds no vault data, and
    // re-choosing it every visit is the kind of friction that reads as
    // unfinished.
    //
    // A reload also drops the keys, by design, so this has to unlock again —
    // which is the point: the preference outlives the session it was set in,
    // and nothing else does.
    const email = await openVault(page, 'layout-memory');
    await makeLogin(page, 'GitHub');

    await page.getByTestId('toggle-layout').click();

    await page.reload();
    await page.getByTestId('go-unlock').click();
    await unlock(page, email);

    await expect(page.getByTestId('item-list')).toHaveAttribute('data-layout', 'grid', {
      timeout: 20_000,
    });
  });

  test('stores a preference and nothing else', async ({ page }) => {
    await openVault(page, 'layout-storage');
    await makeLogin(page, 'SecretTitle', { password: 'plaintext-value' });
    await page.getByTestId('toggle-layout').click();

    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).toContain('grid');
    expect(stored).not.toContain('SecretTitle');
    expect(stored).not.toContain('plaintext-value');
  });
});

test.describe('bulk selection', () => {
  test.slow();

  test('selects and counts', async ({ page }) => {
    await openVault(page, 'bulk-count');
    await makeLogin(page, 'One');
    await makeLogin(page, 'Two');

    await page.getByTestId('toggle-select').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('0');

    await page.getByTestId('select-item').first().check();
    await expect(page.getByTestId('bulk-count')).toHaveText('1');

    await page.getByTestId('bulk-all').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('2');

    await page.getByTestId('bulk-none').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('0');
  });

  test('deletes the selection and offers a way back', async ({ page }) => {
    // Unlike a single delete, it is not obvious from the screen what just went.
    await openVault(page, 'bulk-delete');
    await makeLogin(page, 'One');
    await makeLogin(page, 'Two');

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('bulk-all').click();
    await page.getByTestId('bulk-delete').click();

    await expect(page.getByTestId('item-row')).toHaveCount(0);

    await page.getByTestId('toast-action').click();
    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });

  test('moves the selection into a folder', async ({ page }) => {
    await openVault(page, 'bulk-move');
    await makeFolder(page, 'Work');
    await makeLogin(page, 'One');
    await makeLogin(page, 'Two');

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('bulk-all').click();

    await page.getByTestId('bulk-move').click();
    await page.getByTestId('bulk-move-option').filter({ hasText: 'Work' }).click();

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('folder-chip').click();
    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });

  test('adds a tag rather than replacing the ones already there', async ({ page }) => {
    // A bulk action that discarded existing tags would be a silent edit of
    // every item it touched.
    await openVault(page, 'bulk-tag');
    await makeLogin(page, 'One', { tags: 'existing' });

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('bulk-all').click();
    await page.getByTestId('bulk-tag').fill('added');
    await page.getByTestId('bulk-tag-apply').click();

    await page.getByTestId('toggle-select').click();
    const tags = page.getByTestId('item-row-tags');
    await expect(tags).toContainText('#existing');
    await expect(tags).toContainText('#added');
  });

  test('does not tag the same item twice', async ({ page }) => {
    await openVault(page, 'bulk-tag-twice');
    await makeLogin(page, 'One', { tags: 'work' });

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('bulk-all').click();
    await page.getByTestId('bulk-tag').fill('work');
    await page.getByTestId('bulk-tag-apply').click();

    await page.getByTestId('toggle-select').click();
    await expect(page.getByTestId('item-row-tags')).toHaveText('#work');
  });

  test('offers no actions until something is selected', async ({ page }) => {
    await openVault(page, 'bulk-empty');
    await makeLogin(page, 'One');

    await page.getByTestId('toggle-select').click();
    await expect(page.getByTestId('bulk-delete')).toHaveCount(0);
    await expect(page.getByTestId('bulk-move')).toHaveCount(0);
  });

  test('leaving selection mode drops the selection', async ({ page }) => {
    await openVault(page, 'bulk-exit');
    await makeLogin(page, 'One');

    await page.getByTestId('toggle-select').click();
    await page.getByTestId('bulk-all').click();
    await page.getByTestId('toggle-select').click();

    await page.getByTestId('toggle-select').click();
    await expect(page.getByTestId('bulk-count')).toHaveText('0');
  });

  test('a swipe does not copy while selecting', async ({ page, isMobile }) => {
    test.skip(isMobile !== true, 'touch only');

    // A thumb reaching for a checkbox that instead put a password on the
    // clipboard would be the worst kind of surprise.
    await openVault(page, 'bulk-no-swipe');
    await makeLogin(page, 'One', { password: 'not-copied' });

    await page.getByTestId('toggle-select').click();

    await page.getByTestId('item-row').evaluate((element) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;

      const fire = (type: string, atX: number): void => {
        const touch = new Touch({ identifier: 1, target: element, clientX: atX, clientY: y });
        const list = type === 'touchend' ? [] : [touch];
        element.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: list,
            targetTouches: list,
            changedTouches: [touch],
          }),
        );
      };

      fire('touchstart', x);
      fire('touchmove', x - 60);
      fire('touchmove', x - 110);
      fire('touchend', x - 110);
    });

    await expect(page.getByTestId('toast')).toHaveCount(0);
  });
});

test.describe('the toast stack and the phone bar', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile !== true, 'the bar only exists on a phone');

  test('a toast does not cover the navigation bar', async ({ page }) => {
    // The stack spans the full width, so parked over the bar it swallows the
    // taps meant for it. Found by a test that deleted an item and then could
    // not reach the trash tab.
    await openVault(page, 'toast-vs-bar');
    await makeLogin(page, 'Disposable');

    await page.getByTestId('delete-item').click();
    await expect(page.getByTestId('toast')).toBeVisible();

    const toast = await page.getByTestId('toast').boundingBox();
    const bar = await page.getByTestId('bottom-nav').boundingBox();
    if (!toast || !bar) throw new Error('expected both to be laid out');

    expect(toast.y + toast.height).toBeLessThanOrEqual(bar.y + 1);

    // And the tab it was covering still works.
    await page.getByTestId('nav-trash').click();
    await expect(page.getByTestId('trash-list')).toContainText('Disposable');
  });
});
