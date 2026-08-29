import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount, unlockVault } from './helpers/vault';
import { openPanel } from './helpers/vault-nav';

/**
 * When the vault locks itself.
 *
 * The assertions that matter are the ones about *not* locking, because that is
 * the direction the failures go quietly. A vault that locks too eagerly is
 * reported within a minute; a vault that stayed open when it was told to lock
 * is discovered by whoever walks up to the machine.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function openSettings(page: Page): Promise<void> {
  await openPanel(page, 'open-lock-settings');
  await expect(page.getByTestId('lock-settings')).toBeVisible();
}

/** Hide the tab, the way switching to another one does. */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

test.describe('auto-lock settings', () => {
  test.slow();

  test('offers the four choices and starts on five minutes', async ({ page }) => {
    await openVault(page, 'lock-choices');
    await openSettings(page);

    const choices = page.getByTestId('lock-settings').getByRole('radio');
    await expect(choices).toHaveCount(4);

    // `exact`, because "5 minutes" is a substring of "15 minutes" and the
    // loose match resolved to both.

    await expect(page.getByRole('radio', { name: '5 minutes', exact: true })).toBeChecked();
  });

  test('remembers the choice across a reload', async ({ page }) => {
    // A setting that has to be re-chosen every visit is one people stop
    // choosing.
    const email = await openVault(page, 'lock-remember');
    await openSettings(page);
    await page.getByRole('radio', { name: '1 minute', exact: true }).check();

    // A reload discards the in-memory keys by design, so getting back in means
    // unlocking again. That is the point of the test: the preference has to
    // outlive the keys, and it is stored where the keys are not.
    await page.reload();
    await unlockVault(page, email, PASSWORD);

    await openSettings(page);
    await expect(page.getByRole('radio', { name: '1 minute', exact: true })).toBeChecked();
  });

  test('says plainly what never means', async ({ page }) => {
    // Offered because refusing to offer it does not stop anyone — it moves them
    // to a vault that leaves itself open by default, which is worse. What it
    // gets is the plainest wording on the screen.
    await openVault(page, 'lock-never');
    await openSettings(page);

    await expect(page.getByTestId('never-warning')).toHaveCount(0);
    await page.getByRole('radio', { name: 'never', exact: true }).check();
    await expect(page.getByTestId('never-warning')).toBeVisible();
  });

  test('hiding the tab does not lock while the setting is off', async ({ page }) => {
    // The default. Switching tabs is not an event worth losing your keys over,
    // and a product that locked on it would be one people leave.
    await openVault(page, 'lock-blur-off');
    await hideTab(page);

    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('hiding the tab locks at once when the setting is on', async ({ page }) => {
    await openVault(page, 'lock-blur-on');
    await openSettings(page);
    await page.getByTestId('lock-on-blur').check();
    await page.getByTestId('lock-settings-back').click();

    await hideTab(page);
    await expect(page.getByTestId('vault-state')).toContainText('locked');
  });

  test('coming back to the tab does not lock', async ({ page }) => {
    // `visibilitychange` fires on the way back too. Locking then would lock the
    // vault at the exact moment its owner returned to it.
    await openVault(page, 'lock-blur-return');
    await openSettings(page);
    await page.getByTestId('lock-on-blur').check();
    await page.getByTestId('lock-settings-back').click();

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'visible',
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('a locked vault says it locked itself', async ({ page }) => {
    await openVault(page, 'lock-automatic');
    await openSettings(page);
    await page.getByTestId('lock-on-blur').check();
    await page.getByTestId('lock-settings-back').click();
    await hideTab(page);

    await expect(page.getByTestId('vault-state')).toContainText('locked');
    // Locking is not signing out: the session survives and only the keys go.
    await expect(page).toHaveURL(/\/vault$/);
  });
});
