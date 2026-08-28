import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { openVault as openAccount } from './helpers/vault';

/**
 * The breach check.
 *
 * The only part of this product that reaches past its own server, which is why
 * most of what is asserted here is about restraint: nothing goes out until it
 * has been switched on, what goes out is a five-character prefix and never the
 * password, and a service that cannot be reached says so rather than reporting
 * a clean vault.
 *
 * Have I Been Pwned is never actually called. Every test intercepts the proxy
 * route: a suite that depended on a third party would be a suite that fails
 * when somebody else has an outage, and it would be sending real password
 * hashes out of a test run.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

/** SHA-1 of "password1", which is the value used as the breached one below. */
const LEAKED = 'password1';

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

/**
 * Every prefix answers with the real suffix for `LEAKED`, plus padding.
 *
 * Hashed here rather than in the page. This runs before the first navigation,
 * so `page.evaluate` would be executing on `about:blank`, where `crypto.subtle`
 * is not available — which is what the first version of this did, and it took
 * five tests down in under a second each.
 */
async function stubBreachApi(page: Page, prefixes: string[]): Promise<void> {
  const suffix = createHash('sha1').update(LEAKED).digest('hex').toUpperCase().slice(5);

  await page.route('**/api/breach**', async (route) => {
    prefixes.push(new URL(route.request().url()).searchParams.get('prefix') ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'text/plain',
      // A padding line with a zero count, exactly as the real API sends.
      body: `${suffix}:24230577\n0000000000000000000000000000000000A:0\n`,
    });
  });
}

async function openCheckup(page: Page): Promise<void> {
  await page.getByTestId('open-checkup').click();
  await expect(page.getByTestId('checkup')).toBeVisible();
  await expect(page.getByTestId('checkup-progress')).toHaveCount(0, { timeout: 60_000 });
}

test.describe('breach check', () => {
  test.slow();

  test('is off, and sends nothing, until it is switched on', async ({ page }) => {
    // The assertion this feature turns on. A zero-knowledge tool that quietly
    // started making outbound requests would be lying about what it is.
    const prefixes: string[] = [];
    await stubBreachApi(page, prefixes);

    await openVault(page, 'breach-off');
    await makeLogin(page, 'Old Forum', LEAKED);
    await openCheckup(page);

    await expect(page.getByTestId('breach-toggle')).not.toBeChecked();
    expect(prefixes).toEqual([]);
  });

  test('finds a password that appears in the corpus', async ({ page }) => {
    const prefixes: string[] = [];
    await stubBreachApi(page, prefixes);

    await openVault(page, 'breach-found');
    await makeLogin(page, 'Old Forum', LEAKED);
    await openCheckup(page);

    await page.getByTestId('breach-toggle').check();

    const finding = page.getByTestId('checkup-finding').filter({ hasText: 'published breach' });
    await expect(finding).toBeVisible({ timeout: 60_000 });
    await expect(finding).toContainText('Old Forum');
  });

  test('sends five characters, and never the password', async ({ page }) => {
    const prefixes: string[] = [];
    await stubBreachApi(page, prefixes);

    await openVault(page, 'breach-prefix');
    await makeLogin(page, 'Old Forum', LEAKED);
    await openCheckup(page);
    await page.getByTestId('breach-toggle').check();

    await expect(
      page.getByTestId('checkup-finding').filter({ hasText: 'published breach' }),
    ).toBeVisible({
      timeout: 60_000,
    });

    expect(prefixes.length, 'nothing was requested, so this proves nothing').toBeGreaterThan(0);
    for (const prefix of prefixes) {
      expect(prefix).toMatch(/^[0-9A-F]{5}$/);
    }
    expect(prefixes.join(' ')).not.toContain(LEAKED);
  });

  test('says so when the service cannot be reached', async ({ page }) => {
    // The worst possible failure mode for this check is a quiet "nothing
    // found", which reads exactly like good news.
    await page.route('**/api/breach**', (route) => route.fulfill({ status: 502, body: '' }));

    await openVault(page, 'breach-down');
    await makeLogin(page, 'Old Forum', LEAKED);
    await openCheckup(page);
    await page.getByTestId('breach-toggle').check();

    await expect(page.getByTestId('breach-failed')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('checkup-clear')).toHaveCount(0);
  });

  test('the switch is remembered', async ({ page }) => {
    const prefixes: string[] = [];
    await stubBreachApi(page, prefixes);

    const email = await openVault(page, 'breach-remember');
    await openCheckup(page);
    await page.getByTestId('breach-toggle').check();

    await page.goto('/login');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(PASSWORD);
    await page.getByTestId('unlock').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await openCheckup(page);
    await expect(page.getByTestId('breach-toggle')).toBeChecked();
  });

  test('asks once per prefix, however many passwords share it', async ({ page }) => {
    // Three items, one password: one request. Without the cache this is three,
    // which is three times the traffic and three times the timing signal.
    const prefixes: string[] = [];
    await stubBreachApi(page, prefixes);

    await openVault(page, 'breach-cache');
    await makeLogin(page, 'Alpha', LEAKED);
    await makeLogin(page, 'Beta', LEAKED);
    await makeLogin(page, 'Gamma', LEAKED);
    await openCheckup(page);
    await page.getByTestId('breach-toggle').check();

    await expect(
      page.getByTestId('checkup-finding').filter({ hasText: 'published breach' }),
    ).toBeVisible({
      timeout: 60_000,
    });

    expect(prefixes).toHaveLength(1);
  });

  test('the proxy refuses anything that is not a five-character prefix', async ({ page }) => {
    await openVault(page, 'breach-proxy');

    for (const bad of ['', 'zzzzz', 'abcd', 'abcdef', '../../etc']) {
      const response = await page.request.get(`/api/breach?prefix=${encodeURIComponent(bad)}`);
      expect(response.status(), `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
  });
});
