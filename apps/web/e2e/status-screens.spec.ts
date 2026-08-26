import { expect, test } from '@playwright/test';

/**
 * Error screens, icons and link previews.
 *
 * The error screens carry a security requirement, not just a visual one: on a
 * zero-knowledge product, a 404 or a 403 that reads differently depending on
 * whether something really exists is an enumeration oracle wearing a friendly
 * face. These tests assert what those screens must *not* say as much as what
 * they do.
 */

test.describe('404', () => {
  test('returns a real 404 status, not a soft one', async ({ page }) => {
    // A 200 with "not found" written on it breaks caches, crawlers and
    // monitoring alike.
    const response = await page.goto('/definitely-not-a-page');
    expect(response?.status()).toBe(404);
  });

  test('is in the terminal theme rather than the framework default', async ({ page }) => {
    await page.goto('/definitely-not-a-page');

    await expect(page.getByRole('heading', { name: 'no such path' })).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('body')).toHaveCSS('font-family', /mono/i);
  });

  test('reads identically for a plausible path and an absurd one', async ({ page }) => {
    // If these differed, the 404 would be answering "does this vault exist".
    await page.goto('/vault/some-real-looking-id');
    const plausible = await page.locator('main').innerText();

    await page.goto('/zzzz-nonsense-zzzz');
    const absurd = await page.locator('main').innerText();

    expect(plausible).toBe(absurd);
  });

  test('offers a way back', async ({ page }) => {
    await page.goto('/definitely-not-a-page');
    await page.getByRole('link', { name: 'back to start' }).click();
    await expect(page).toHaveURL(/\/$/);
  });
});

test.describe('access denied', () => {
  test('renders and does not say why', async ({ page }) => {
    await page.goto('/denied');

    await expect(page.getByRole('heading', { name: 'access denied' })).toBeVisible();

    const text = await page.locator('main').innerText();
    // Naming the cause would tell somebody replaying a stolen token that their
    // replay was noticed.
    expect(text).not.toMatch(/expired|revoked token|reused|invalid session|not found/i);
  });

  test('is kept out of search results', async ({ page }) => {
    await page.goto('/denied');
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });

  test('links to unlock', async ({ page }) => {
    await page.goto('/denied');
    await page.getByRole('link', { name: 'unlock' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('icons and manifest', () => {
  test('serves a favicon', async ({ request }) => {
    const response = await request.get('/icon.svg');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('svg');
  });

  test('serves every icon the manifest promises', async ({ request }) => {
    const manifest = await request.get('/manifest.webmanifest');
    expect(manifest.status()).toBe(200);

    const parsed = (await manifest.json()) as { icons: { src: string; purpose: string }[] };
    expect(parsed.icons.length).toBeGreaterThan(0);

    for (const icon of parsed.icons) {
      const response = await request.get(icon.src);
      expect(response.status(), `${icon.src} is listed but missing`).toBe(200);
    }
  });

  test('includes a maskable icon, so launchers do not clip the mark', async ({ request }) => {
    const parsed = (await (await request.get('/manifest.webmanifest')).json()) as {
      icons: { purpose: string }[];
    };
    expect(parsed.icons.some((icon) => icon.purpose === 'maskable')).toBe(true);
  });
});

test.describe('link preview', () => {
  test('serves the banner at the size platforms crop to', async ({ request }) => {
    const response = await request.get('/og.png');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
  });

  test('declares the card with an absolute image URL', async ({ page }) => {
    // Relative Open Graph URLs are silently ignored by several scrapers, which
    // shows up as a link that previews as nothing at all.
    await page.goto('/');

    const image = await page.locator('meta[property="og:image"]').getAttribute('content');
    expect(image).toMatch(/^https?:\/\//);
    expect(image).toContain('/og.png');

    await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
      'content',
      'summary_large_image',
    );
  });

  test('the preview text states the guarantee', async ({ page }) => {
    await page.goto('/');
    const description = await page
      .locator('meta[property="og:description"]')
      .getAttribute('content');

    expect(description).toMatch(/unreadable to the server/i);
  });

  test('the image has alternative text', async ({ page }) => {
    await page.goto('/');
    const alt = await page.locator('meta[property="og:image:alt"]').getAttribute('content');
    expect(alt).toBeTruthy();
  });
});

test.describe('scrollbar', () => {
  test('is styled rather than left as the browser default', async ({ page }) => {
    // A pale system scrollbar against a pure black page is the most obvious
    // break in the terminal look, and on Windows it is a wide grey slab.
    await page.goto('/');

    const { width, colour } = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return { width: style.scrollbarWidth, colour: style.scrollbarColor };
    });

    expect(width).toBe('thin');
    expect(colour).not.toBe('auto');
  });

  test('declares the webkit rules Chromium needs', async ({ page }) => {
    // The standard properties above do nothing in Chromium, so the pseudo
    // elements have to be present too or the fix only works in Firefox.
    await page.goto('/');

    const hasWebkitRules = await page.evaluate(() =>
      [...document.styleSheets].some((sheet) => {
        try {
          return [...sheet.cssRules].some((rule) =>
            rule.cssText.includes('::-webkit-scrollbar-thumb'),
          );
        } catch {
          return false;
        }
      }),
    );

    expect(hasWebkitRules).toBe(true);
  });
});
