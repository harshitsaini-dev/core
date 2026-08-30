import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The bot check, and the ways it fails.
 *
 * Turnstile is a third-party script in a cross-origin iframe, which makes it
 * the one part of these screens that can misbehave without anything here being
 * wrong. What matters is that it cannot take the page down with it.
 *
 * It could. `api.reset` throws `TurnstileError: Nothing to reset found for
 * provided container` whenever the widget is not where it expects — unmounted
 * already, never rendered because the script refused the domain, or rendered
 * twice because React ran the effect twice in development. The throw reached
 * React from inside an effect and the root boundary replaced the whole page
 * with "core could not start".
 *
 * It surfaced as intermittent 500 screens in the suite with no matching 500 in
 * the dev server log, because the server was never involved.
 *
 * The reset is what triggers it, and the reset happens after a failed sign-in:
 * a Turnstile token is single-use, so the widget has to be replaced before the
 * next attempt. So these drive a real failed sign-in rather than poking the
 * component, which is the only way to reach the line that threw.
 */

const CRASH_SCREEN = 'core could not start';

/**
 * A Turnstile that renders and then throws when reset.
 *
 * The shape the real script takes once its container has gone.
 */
async function stubThrowingOnReset(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'turnstile', {
      writable: true,
      value: {
        render: () => 'widget-1',
        reset: () => {
          throw new Error('[Cloudflare Turnstile] Nothing to reset found for provided container.');
        },
        remove: () => undefined,
      },
    });
  });
}

/**
 * A Turnstile that declines to render at all.
 *
 * What the real script does for a second widget in one container — it logs
 * "already been rendered" and returns nothing, leaving the caller holding an id
 * that is not one.
 */
async function stubDecliningToRender(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'turnstile', {
      writable: true,
      value: {
        render: () => undefined,
        reset: (id: unknown) => {
          if (id === undefined) {
            throw new Error('[Cloudflare Turnstile] Nothing to reset found for provided container.');
          }
        },
        remove: () => undefined,
      },
    });
  });
}

/** A sign-in that will be refused, which is what resets the widget. */
async function failASignIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('email').fill('nobody@example.com');
  await page.getByLabel('master password').fill('not-the-right-password-at-all');
  await page.getByTestId('unlock').click();
  await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 60_000 });
}

test.describe('the bot check cannot take the page down', () => {
  test.slow();

  test('survives a widget that throws when it is reset', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await stubThrowingOnReset(page);
    await failASignIn(page);

    expect(crashes.join(' '), 'the throw escaped into React').not.toContain('Turnstile');
    await expect(page.getByText(CRASH_SCREEN)).toHaveCount(0);

    // Still usable afterwards, which is the whole point of catching it.
    await expect(page.getByTestId('unlock')).toBeEnabled();
  });

  test('survives a widget that never rendered', async ({ page }) => {
    // `render` hands back nothing when it declines, and resetting an id that is
    // not one throws in the same way.
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await stubDecliningToRender(page);
    await failASignIn(page);

    expect(crashes.join(' '), 'the throw escaped into React').not.toContain('Turnstile');
    await expect(page.getByText(CRASH_SCREEN)).toHaveCount(0);
    await expect(page.getByTestId('unlock')).toBeEnabled();
  });
});
