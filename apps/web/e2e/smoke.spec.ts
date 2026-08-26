import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test.
 *
 * Its job is to prove the toolchain works end to end and to give a target for
 * watching a headed run:
 *
 *   pnpm e2e:ui       time-travel UI, watch mode  (best for development)
 *   pnpm e2e:headed   real browser, slowed to 300ms per action
 *   pnpm e2e:debug    step through with the inspector
 */

test.describe('landing page', () => {
  test('renders the terminal shell', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/core/i);
    await expect(page.getByRole('heading', { name: 'core' })).toBeVisible();
    await expect(
      page.getByText('zero-knowledge password, secret and .env manager'),
    ).toBeVisible();
  });

  test('states the security posture on screen', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByText(/AES-256-GCM \/ client-side only/)).toBeVisible();
    await expect(page.getByText(/Argon2id/)).toBeVisible();
    await expect(page.getByText(/server sees\s+ciphertext/)).toBeVisible();
  });

  test('holds the terminal palette: black background, monospace type', async ({ page }) => {
    await page.goto('/');

    const body = page.locator('body');
    await expect(body).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(body).toHaveCSS('font-family', /mono/i);
  });

  test('has no rounded corners anywhere', async ({ page }) => {
    await page.goto('/');

    const radii = await page.evaluate(() =>
      [...document.querySelectorAll('*')].map((el) => getComputedStyle(el).borderRadius),
    );
    expect(radii.every((radius) => radius === '0px')).toBe(true);
  });

  test('does not link out to the source repository', async ({ page }) => {
    // The deployed site says nothing about where its code lives. Anyone who
    // wants the source can find it; the running instance should not volunteer
    // an external destination on a page users arrive at with a password in mind.
    await page.goto('/');

    const external = await page
      .locator('a[href^="http"]')
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));

    expect(external).toEqual([]);
  });

  test('sets the hardening response headers', async ({ page }) => {
    const response = await page.goto('/');

    const headers = response?.headers() ?? {};
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-powered-by']).toBeUndefined();
  });
});
