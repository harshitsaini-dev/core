import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * The security checkup.
 *
 * Two things are being tested and only one of them is the feature. The first is
 * that the checks find what they claim to find. The second, and the one worth
 * having a suite for, is that a screen whose entire subject is passwords never
 * puts one on screen — it is read in rooms with other people in them, and a
 * "these four accounts share a password" report that named the password would
 * be a ranked list of what to steal first.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

/** A strong, unrelated password: nothing for the checkup to say about it. */
const STRONG = 'Xq7#vNp2$Lr9!Wm4kTz';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function makeLogin(page: Page, title: string, password: string): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-password').fill(password);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function openCheckup(page: Page): Promise<void> {
  await page.getByTestId('open-checkup').click();
  await expect(page.getByTestId('checkup')).toBeVisible();
  // The weak-password pass loads roughly 800 KB of wordlists before it can say
  // anything, so every assertion below waits for the scan to finish first.
  await expect(page.getByTestId('checkup-progress')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('security checkup', () => {
  test.slow();

  test('says so when there is nothing to fix', async ({ page }) => {
    await openVault(page, 'checkup-clean');
    await makeLogin(page, 'Alpha', STRONG);
    await makeLogin(page, 'Beta', 'Jm4!zRq8#tVw2$nX');

    await openCheckup(page);
    await expect(page.getByTestId('checkup-clear')).toBeVisible();
    await expect(page.getByTestId('checkup-finding')).toHaveCount(0);
  });

  test('groups the accounts that share a password', async ({ page }) => {
    await openVault(page, 'checkup-reused');
    await makeLogin(page, 'Alpha', STRONG);
    await makeLogin(page, 'Beta', STRONG);

    await openCheckup(page);

    const findings = page.getByTestId('checkup-finding');
    await expect(findings).toHaveCount(1);
    await expect(findings.first()).toContainText('2 accounts share one password');
    await expect(findings.first()).toContainText('Alpha');
    await expect(findings.first()).toContainText('Beta');
  });

  test('never puts a password on the screen', async ({ page }) => {
    // The assertion this file exists for.
    await openVault(page, 'checkup-no-secrets');
    await makeLogin(page, 'Alpha', STRONG);
    await makeLogin(page, 'Beta', STRONG);
    await makeLogin(page, 'Gamma', 'password1');

    await openCheckup(page);

    const shown = await page.getByTestId('checkup').innerText();

    // Checked first, because `not.toContain` over an empty string passes and
    // says nothing. This proves the text being searched is the report itself.
    expect(shown).toContain('Alpha');
    expect(shown).toContain('Gamma');

    expect(shown).not.toContain(STRONG);
    expect(shown).not.toContain('password1');
  });

  test('finds a password a wordlist would reach', async ({ page }) => {
    await openVault(page, 'checkup-weak');
    await makeLogin(page, 'Gamma', 'password1');

    await openCheckup(page);
    const weak = page.getByTestId('checkup-finding').filter({ hasText: 'weak passwords' });
    await expect(weak).toHaveCount(1);
    await expect(weak).toContainText('Gamma');
  });

  test('counts a login stored without a password', async ({ page }) => {
    // Not a problem by itself. It is here because an import that mapped the
    // wrong column produces exactly this, in bulk, and this is how somebody
    // finds out.
    await openVault(page, 'checkup-missing');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('NoPassword');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-list')).toContainText('NoPassword');

    await openCheckup(page);
    const missing = page
      .getByTestId('checkup-finding')
      .filter({ hasText: 'logins stored without a password' });
    await expect(missing).toContainText('NoPassword');
  });

  test('a finding opens the item it is about', async ({ page }) => {
    // A checkup that only says what is wrong leaves the work of finding each
    // one by hand, which is how a list of problems gets read once and acted on
    // never.
    await openVault(page, 'checkup-open');
    await makeLogin(page, 'Alpha', STRONG);
    await makeLogin(page, 'Beta', STRONG);

    await openCheckup(page);
    await page.getByTestId('checkup-entry').first().click();

    await expect(page.getByTestId('item-title')).toHaveValue('Alpha');
  });

  test('goes back to the list', async ({ page }) => {
    await openVault(page, 'checkup-back');
    await makeLogin(page, 'Alpha', STRONG);

    await openCheckup(page);
    await page.getByTestId('checkup-back').click();

    await expect(page.getByTestId('checkup')).toHaveCount(0);
    await expect(page.getByTestId('item-list')).toBeVisible();
  });
});
