import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Touch gestures: swipe to copy, pull to sync.
 *
 * Phone only. Playwright drives these by dispatching real `TouchEvent`s in the
 * page, because it has no swipe primitive — `touchscreen` can only tap.
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

async function makeLogin(
  page: Page,
  title: string,
  fields: { username?: string; password?: string } = {},
): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  if (fields.username) await page.getByTestId('item-username').fill(fields.username);
  if (fields.password) await page.getByTestId('item-password').fill(fields.password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

/**
 * Drag a finger across an element.
 *
 * `hold` stops before the release, which is how the intermediate state — the
 * hint label, the armed styling — can be observed at all.
 */
async function drag(
  target: Locator,
  { dx = 0, dy = 0, hold = false }: { dx?: number; dy?: number; hold?: boolean },
): Promise<void> {
  await target.evaluate(
    (element, { dx, dy, hold }) => {
      const box = element.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;

      const fire = (type: string, atX: number, atY: number): void => {
        const touch = new Touch({
          identifier: 1,
          target: element,
          clientX: atX,
          clientY: atY,
        });
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

      fire('touchstart', x, y);
      // Several steps, because the first move is what decides whether the
      // gesture is a swipe or a scroll.
      for (const fraction of [0.25, 0.6, 1]) {
        fire('touchmove', x + dx * fraction, y + dy * fraction);
      }
      if (!hold) fire('touchend', x + dx, y + dy);
    },
    { dx, dy, hold },
  );
}

test.describe('swipe actions', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile !== true, 'touch only');

  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('swiping left copies the password', async ({ page }) => {
    await openVault(page, 'swipe-password');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'swiped-secret' });

    await drag(page.getByTestId('item-row'), { dx: -110 });

    await expect(page.getByTestId('copy-password')).toContainText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('swiped-secret');
  });

  test('swiping right copies the username', async ({ page }) => {
    await openVault(page, 'swipe-username');
    await makeLogin(page, 'GitHub', { username: 'swiped-user', password: 'secret' });

    await drag(page.getByTestId('item-row'), { dx: 110 });

    await expect(page.getByTestId('copy-username')).toContainText('copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('swiped-user');
  });

  test('a short swipe does nothing', async ({ page }) => {
    // Otherwise every mistimed scroll puts a password on the clipboard.
    await openVault(page, 'swipe-short');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'secret' });

    await drag(page.getByTestId('item-row'), { dx: -40 });

    await expect(page.getByTestId('copy-password')).toContainText('copy');
    await expect(page.getByTestId('swipe-hint')).toHaveCount(0);
  });

  test('a vertical drag is a scroll, not a swipe', async ({ page }) => {
    await openVault(page, 'swipe-vertical');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'secret' });

    // Diagonal, but mostly down: the list must win.
    await drag(page.getByTestId('item-row'), { dx: -110, dy: 200 });

    await expect(page.getByTestId('copy-password')).toContainText('copy');
  });

  test('names the action before the finger lifts', async ({ page }) => {
    await openVault(page, 'swipe-hint');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'secret' });

    await drag(page.getByTestId('item-row'), { dx: -110, hold: true });
    await expect(page.getByTestId('swipe-hint')).toContainText('copy password');

    // Nothing has happened yet — the hint is a promise, not a receipt.
    await expect(page.getByTestId('copy-password')).toContainText('copy');
  });

  test('a row with nothing to copy does not move', async ({ page }) => {
    await openVault(page, 'swipe-note');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-note').click();
    await page.getByTestId('note-body').fill('Nothing to copy here.');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-row')).toHaveCount(1);

    await drag(page.getByTestId('item-row'), { dx: -110 });
    await expect(page.getByTestId('swipe-hint')).toHaveCount(0);
  });
});

test.describe('pull to sync', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile !== true, 'touch only');

  test('pulling far enough syncs', async ({ page }) => {
    await openVault(page, 'pull');
    await makeLogin(page, 'GitHub', { password: 'secret' });

    await drag(page.getByTestId('pull-to-refresh'), { dy: 220 });

    await expect(page.getByTestId('connection-status')).toContainText('synced');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
  });

  test('says what a release would do', async ({ page }) => {
    await openVault(page, 'pull-armed');

    await drag(page.getByTestId('pull-to-refresh'), { dy: 220, hold: true });
    await expect(page.getByTestId('pull-indicator')).toContainText('release to sync');
  });

  test('a short pull is not armed', async ({ page }) => {
    await openVault(page, 'pull-short');

    await drag(page.getByTestId('pull-to-refresh'), { dy: 60, hold: true });
    await expect(page.getByTestId('pull-indicator')).toContainText('pull to sync');
  });

  test('an upward drag shows nothing', async ({ page }) => {
    await openVault(page, 'pull-up');

    await drag(page.getByTestId('pull-to-refresh'), { dy: -120, hold: true });
    await expect(page.getByTestId('pull-indicator')).toHaveCount(0);
  });

  test('the vault still works after a pull that did nothing', async ({ page }) => {
    await openVault(page, 'pull-noop');

    await drag(page.getByTestId('pull-to-refresh'), { dy: 30 });

    await page.getByTestId('new-item').click();
    await expect(page.getByTestId('item-title')).toBeVisible();
  });
});
