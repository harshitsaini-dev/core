import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Reaching a panel that lives behind the vault's `more` drawer.
 *
 * The footer used to be thirteen buttons in a row and every spec clicked its
 * own directly. They are grouped now, so a test that still clicks straight
 * through would be testing a layout that no longer exists — and, worse, would
 * pass for as long as the button happened to be somewhere on the page.
 *
 * Idempotent on purpose. A spec that opens two panels in a row should not have
 * to know whether the drawer is already open, and a helper that toggled blindly
 * would close it on the second call.
 */
export async function openPanel(page: Page, testId: string): Promise<void> {
  const target = page.getByTestId(testId);

  if ((await target.count()) === 0 || !(await target.first().isVisible())) {
    await page.getByTestId('open-more').click();
    await expect(page.getByTestId('more-actions')).toBeVisible();
  }

  await target.first().click();
}
