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
    await expect(page.getByText('zero-knowledge password, secret and .env manager')).toBeVisible();
  });

  test('offers a way into the app', async ({ page }) => {
    /*
     * This is the test that was missing. The landing page rendered its status
     * readout for months with no link on it at all — you could not sign up or
     * unlock from the front page of a password manager — and everything here
     * passed the whole time, because it only ever checked the heading.
     */
    await page.goto('/');

    await expect(page.getByTestId('go-signup')).toBeVisible();
    await expect(page.getByTestId('go-login')).toBeVisible();
  });

  test('the way in goes where it says', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('go-signup').click();
    await expect(page).toHaveURL(/\/signup$/);

    await page.goto('/');
    await page.getByTestId('go-login').click();
    await expect(page).toHaveURL(/\/login$/);
  });

  test('claims nothing the app does not do', async ({ page }) => {
    // An earlier version printed `t=3` while the app calibrated to twelve or
    // more, and said the vault was "in development" long after it was not. This
    // is the most-read page in the product; a number nobody checks is still a
    // claim.
    await page.goto('/');

    const text = await page.locator('main').innerText();
    expect(text).not.toContain('in development');
    expect(text).not.toMatch(/t=\d/);
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

test.describe('installing it', () => {
  /*
   * The button appears only when the browser says the app can be installed.
   *
   * Chrome fires `beforeinstallprompt` when a page meets the installability
   * criteria and is not already installed, so a button that waits for it is a
   * button that is never a lie. The alternative — a permanent "Install app" —
   * does nothing on Safari and offers to install something already installed
   * everywhere else, and on the first screen of a password manager a control
   * that does nothing is expensive.
   */

  test('is not offered until the browser offers it', async ({ page }) => {
    // Playwright's Chromium does not fire the event, which is exactly the case
    // this asserts: no event, no button.
    await page.goto('/');
    await expect(page.getByTestId('install-app')).toHaveCount(0);
  });

  test('appears when the browser fires the prompt', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt') as Event & {
        prompt?: () => Promise<void>;
        userChoice?: Promise<{ outcome: string }>;
      };
      event.prompt = () => Promise.resolve();
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });

    await expect(page.getByTestId('install-app')).toBeVisible();
  });

  test('goes away once the app is installed', async ({ page }) => {
    await page.goto('/');

    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt') as Event & { prompt?: () => Promise<void> };
      event.prompt = () => Promise.resolve();
      window.dispatchEvent(event);
    });
    await expect(page.getByTestId('install-app')).toBeVisible();

    await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
    await expect(page.getByTestId('install-app')).toHaveCount(0);
  });
});
