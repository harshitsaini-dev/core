import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Mobile layout.
 *
 * Core is meant to be used from a phone more than from a desktop, so these run
 * against the `mobile` project (a Pixel 7 viewport) as well as everything else.
 *
 * They check the failures that are invisible on a wide screen and obvious on a
 * narrow one: content wider than the viewport, targets too small to hit with a
 * thumb, and inputs small enough that iOS Safari zooms the page on focus and
 * shoves the rest of the form out of view mid-entry.
 */

const PAGES = ['/', '/signup', '/login', '/recover', '/vault'] as const;

/** The smallest target most people can hit reliably with a thumb. */
const MIN_TOUCH_TARGET_PX = 44;

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test.describe('mobile layout', () => {
  // Only meaningful at a phone viewport; on desktop these pass vacuously.
  test.skip(({ isMobile }) => !isMobile, 'mobile viewport only');

  for (const path of PAGES) {
    test(`${path} fits the viewport without sideways scrolling`, async ({ page }) => {
      await page.goto(path);
      // A couple of pixels of rounding is tolerable; a scrollbar is not.
      expect(await horizontalOverflow(page)).toBeLessThanOrEqual(2);
    });
  }

  test('buttons are large enough to hit with a thumb', async ({ page }) => {
    await page.goto('/signup');

    // Scoped to <main>: in development Next injects its own dev-tools button,
    // and measuring the framework's chrome instead of ours would fail for a
    // reason that has nothing to do with the product.
    const buttons = page.locator('main').getByRole('button');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const box = await buttons.nth(index).boundingBox();
      const label = await buttons.nth(index).textContent();
      expect(box?.height ?? 0, `button "${label?.trim()}" is too short`).toBeGreaterThanOrEqual(
        MIN_TOUCH_TARGET_PX,
      );
    }
  });

  test('inputs are large enough, and typed at a size iOS will not zoom', async ({ page }) => {
    await page.goto('/signup');

    const inputs = page
      .locator('main')
      .locator('input[type="email"], input[type="password"], input[type="text"]');
    const count = await inputs.count();
    expect(count).toBeGreaterThan(0);

    for (let index = 0; index < count; index += 1) {
      const input = inputs.nth(index);
      const box = await input.boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);

      // Below 16px, mobile Safari zooms in when the field takes focus.
      const fontSize = await input.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).fontSize),
      );
      expect(fontSize).toBeGreaterThanOrEqual(16);
    }
  });

  test('the signup form is usable end to end on a phone', async ({ page }) => {
    await page.goto('/signup');

    await page.getByLabel('email').fill('phone@core.test');
    await page.getByLabel('master password', { exact: true }).fill('correct-horse-battery-7391');
    await page.getByLabel('confirm master password').fill('correct-horse-battery-7391');

    // Filling the form must not push anything off screen.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(2);
    await expect(page.getByRole('button', { name: 'create vault' })).toBeInViewport();
  });

  test('the no-reset warning is visible without scrolling past the button', async ({ page }) => {
    // A warning a user never reaches is not a warning, and on a phone it is
    // easy for one to end up below the fold under the thing it warns about.
    await page.goto('/signup');

    const warning = page.getByText(/no password reset/i);
    const button = page.getByRole('button', { name: 'create vault' });

    const warningBox = await warning.boundingBox();
    const buttonBox = await button.boundingBox();

    expect(warningBox?.y ?? 0).toBeLessThan(buttonBox?.y ?? 0);
  });

  test('long text wraps rather than stretching the page', async ({ page }) => {
    // The recovery key is 43 unbroken characters, which is exactly the kind of
    // string that silently widens a phone layout.
    await page.goto('/recover');
    await page.getByLabel('recovery key').fill('A'.repeat(43));

    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(2);
  });
});

test.describe('glow', () => {
  test('marks interactive elements rather than decorating static text', async ({
    page,
    isMobile,
  }) => {
    // Hover does not exist on a touch device, so there is nothing here to
    // assert. Skipped rather than weakened into a test that passes everywhere
    // and checks nothing.
    test.skip(isMobile, 'no hover on touch');

    // A permanently glowing button is just a bright button. The effect has to
    // change on interaction to carry any information.
    //
    // Asserted on hover rather than focus: `:focus-visible` is a browser
    // heuristic that a programmatic `.focus()` does not reliably satisfy, which
    // passes headed locally and fails headless in CI for reasons that have
    // nothing to do with the styling.
    await page.goto('/signup');

    const button = page.getByRole('button', { name: 'create vault' });
    const resting = await button.evaluate((element) => getComputedStyle(element).boxShadow);

    await page.getByLabel('email').fill('glow@core.test');
    await page.getByLabel('master password', { exact: true }).fill('correct-horse-battery-7391');
    await page.getByLabel('confirm master password').fill('correct-horse-battery-7391');
    await button.hover();

    expect(resting).toBe('none');

    // Polled rather than read once. The pointer landing and the style being
    // recomputed are two separate frames, and under a loaded machine the second
    // one is not always there yet — which failed this test in a full-suite run
    // while passing every time it ran alone.
    const shadow = expect.poll(async () =>
      button.evaluate((element) => getComputedStyle(element).boxShadow),
    ).not;
    await shadow.toBe('none');

    const hovered = await button.evaluate((element) => getComputedStyle(element).boxShadow);
    expect(hovered).toContain('rgba(0, 255, 65');
  });

  test('lights the heading in the accent colour', async ({ page }) => {
    await page.goto('/signup');
    const shadow = await page
      .getByRole('heading')
      .first()
      .evaluate((element) => getComputedStyle(element).textShadow);

    expect(shadow).toContain('rgba(0, 255, 65');
  });

  test('lights an input on focus', async ({ page }) => {
    await page.goto('/login');
    const input = page.getByLabel('email');

    const resting = await input.evaluate((element) => getComputedStyle(element).boxShadow);
    // Inputs use plain `:focus`, not `:focus-visible`, so clicking is enough.
    await input.click();
    const focused = await input.evaluate((element) => getComputedStyle(element).boxShadow);

    expect(resting).toBe('none');
    expect(focused).toContain('rgba(0, 255, 65');
  });
});
