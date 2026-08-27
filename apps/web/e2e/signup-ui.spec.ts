import { expect, test } from '@playwright/test';
import type { Page, Request } from '@playwright/test';

/**
 * The signup screen.
 *
 * Unlike the API specs, these drive the real UI — so a headed run actually shows
 * something. The most valuable test here is the last one: it watches every
 * outbound request and asserts the recovery key never appears in any of them.
 * That is the zero-knowledge claim checked at the surface a user actually
 * touches, rather than one layer down where it is easier to be sure of.
 */

const STRONG = 'correct-horse-battery-staple-7391';
const WEAK = 'password123';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

async function fillForm(page: Page, email: string, password: string, confirm = password) {
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password', { exact: true }).fill(password);
  await page.getByLabel('confirm master password').fill(confirm);
}

const submit = (page: Page) => page.getByRole('button', { name: 'create vault' });

test.describe('signup form', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/signup');
  });

  test('renders in the terminal theme', async ({ page }) => {
    await expect(page.getByRole('heading', { name: /core --create-vault/ })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('body')).toHaveCSS('font-family', /mono/i);
  });

  test('states up front that there is no password reset', async ({ page }) => {
    // A user cannot consent to a consequence they were not told about, and this
    // one is permanent.
    await expect(page.getByText(/no password reset/i)).toBeVisible();
    await expect(page.getByText(/the vault is gone for good/i)).toBeVisible();
    await expect(page.getByText(/nobody can recover it/i)).toBeVisible();
  });

  test('cannot be submitted empty', async ({ page }) => {
    await expect(submit(page)).toBeDisabled();
  });

  test('refuses a weak master password rather than merely warning', async ({ page }) => {
    // There is no reset here, so a weak password is not a risk the user can
    // revisit later. It is a permanent property of their vault.
    await fillForm(page, uniqueEmail('weak'), WEAK);

    await expect(page.getByRole('alert').first()).toBeVisible();
    await expect(submit(page)).toBeDisabled();
  });

  test('accepts a strong passphrase', async ({ page }) => {
    await fillForm(page, uniqueEmail('strong'), STRONG);
    await expect(submit(page)).toBeEnabled();
  });

  test('shows how long an offline attacker would need', async ({ page }) => {
    await fillForm(page, uniqueEmail('crack'), STRONG);
    await expect(page.getByText(/an offline attacker would need/i)).toBeVisible();
  });

  test('the meter conveys strength by more than colour', async ({ page }) => {
    // The palette is a single hue and a meaningful fraction of readers cannot
    // rely on it, so the filled-block count and the written label carry the
    // message.
    await fillForm(page, uniqueEmail('meter'), WEAK);
    const weakFilled = await page.locator('[data-filled="true"]').count();
    await expect(page.getByTestId('strength-summary')).toContainText(/weak|unusable|fair/);

    await page.getByLabel('master password', { exact: true }).fill(STRONG);
    await expect(page.getByTestId('strength-summary')).toContainText(/strong|good/);
    expect(await page.locator('[data-filled="true"]').count()).toBeGreaterThan(weakFilled);
  });

  test('blocks a mismatched confirmation', async ({ page }) => {
    await fillForm(page, uniqueEmail('mismatch'), STRONG, `${STRONG}-typo`);

    await expect(page.getByText('The two passwords do not match.')).toBeVisible();
    await expect(submit(page)).toBeDisabled();
  });

  test('every field is reachable and labelled for a screen reader', async ({ page }) => {
    for (const label of ['email', 'master password', 'confirm master password']) {
      await expect(page.getByLabel(label, { exact: true })).toBeVisible();
    }
  });
});

test.describe('creating a vault', () => {
  // Real key derivation runs here, calibrated to cost about half a second.
  test.slow();

  test('produces an Emergency Kit', async ({ page }) => {
    const email = uniqueEmail('kit');
    await page.goto('/signup');
    await fillForm(page, email, STRONG);
    await submit(page).click();

    await expect(page.getByRole('heading', { name: /emergency kit/i })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId('kit-email')).toHaveText(email);

    // 32 bytes, base64url, shown in groups of eight.
    const key = (await page.getByTestId('kit-recovery-key').textContent()) ?? '';
    expect(key.replace(/\s/g, '')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test('requires an explicit acknowledgement before moving on', async ({ page }) => {
    // A dismissible toast is not consent for something this irreversible.
    await page.goto('/signup');
    await fillForm(page, uniqueEmail('ack'), STRONG);
    await submit(page).click();

    await expect(page.getByTestId('kit-continue')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('kit-continue')).toBeDisabled();

    await page.getByTestId('kit-acknowledge').check();
    await expect(page.getByTestId('kit-continue')).toBeEnabled();
  });

  test('never sends the master password or the recovery key anywhere', async ({ page }) => {
    // The claim the whole product rests on, checked at the surface a user
    // actually touches.
    const email = uniqueEmail('zk');
    const outbound: string[] = [];

    page.on('request', (request: Request) => {
      const body = request.postData();
      if (body) outbound.push(body);
    });

    await page.goto('/signup');
    await fillForm(page, email, STRONG);
    await submit(page).click();

    await expect(page.getByTestId('kit-recovery-key')).toBeVisible({ timeout: 30_000 });
    const recoveryKey = ((await page.getByTestId('kit-recovery-key').textContent()) ?? '').replace(
      /\s/g,
      '',
    );

    expect(outbound.length, 'expected the signup request to have been captured').toBeGreaterThan(0);

    for (const body of outbound) {
      expect(body, 'the master password left the browser').not.toContain(STRONG);
      expect(body, 'the recovery key left the browser').not.toContain(recoveryKey);
    }
  });
});
