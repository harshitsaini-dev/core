import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Getting around without a mouse.
 *
 * Two things, and the second is the one that rots. Every control has to be
 * reachable by tab, and every control that has focus has to *look* like it —
 * a keyboard user meeting an unstyled button has no idea where they are, and
 * that is a state a product reaches one carelessly-added `<button>` at a time.
 *
 * So the assertions are written against whatever is on screen rather than
 * against a list of components, which is what makes them survive the next
 * panel somebody adds.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

/** Whether the focused element is drawing something a person could see. */
async function focusRing(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return 'nothing is focused';

    const style = getComputedStyle(el);
    const outline = `${style.outlineStyle} ${style.outlineWidth}`;
    const shadowed = style.boxShadow !== 'none';

    return outline !== 'none 0px' || shadowed ? 'visible' : `nothing on <${el.tagName}>`;
  });
}

test.describe('keyboard navigation', () => {
  test.slow();
  test.skip(({ isMobile }) => isMobile === true, 'no tab key on a phone');

  test('every control on the vault shows a ring when tabbed to', async ({ page }) => {
    // Walked rather than listed. A test against a list of components passes
    // forever while the untested ones pile up next to them.
    await openVault(page, 'kbd-ring');

    const problems: string[] = [];
    for (let step = 0; step < 25; step += 1) {
      await page.keyboard.press('Tab');
      const state = await focusRing(page);
      if (state !== 'visible' && state !== 'nothing is focused') problems.push(state);
    }

    expect(problems).toEqual([]);
  });

  test('a raw button gets a ring too, without asking for one', async ({ page }) => {
    /*
     * The floor, specifically. The walk above passes on the components that
     * already carry their own `focus-visible` classes, so it says nothing about
     * the plain `<button>` somebody adds in a hurry — and removing the
     * stylesheet rule left it passing, which is how that was found.
     *
     * `toggle-blur` is one of seventeen raw buttons in the app and asks for no
     * focus styling of its own.
     */
    await openVault(page, 'kbd-raw-button');

    const raw = page.getByTestId('toggle-blur');

    // Tabbed to, not `focus()`ed. Programmatic focus deliberately does not
    // count as focus-visible — that is the whole distinction the pseudo-class
    // draws, and the first version of this test tripped over it.
    await raw.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(raw).toBeFocused();

    const ring = await raw.evaluate((el) => ({
      style: getComputedStyle(el).outlineStyle,
      width: Number.parseFloat(getComputedStyle(el).outlineWidth),
    }));

    // Width compared as a number: the declared 2px comes back as 1.6px under
    // this device scale, and asserting the string would be asserting the zoom.
    expect(ring.style).toBe('solid');
    expect(ring.width).toBeGreaterThan(0);
  });

  test('a ring appears for the keyboard and not for the mouse', async ({ page }) => {
    // The whole reason this uses `:focus-visible`. Styling `:focus` leaves a
    // ring behind on every button a mouse touches, which is why so many
    // products removed it entirely and left keyboard users with nothing.
    await openVault(page, 'kbd-visible-only');
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('GitHub');
    await page.getByTestId('item-password').fill('a-stored-secret');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-list')).toContainText('GitHub');

    const pin = page.getByTestId('toggle-favorite').first();

    await pin.click();
    expect(
      await pin.evaluate((el) => getComputedStyle(el).outlineStyle),
      'a mouse click left a ring behind',
    ).toBe('none');

    await pin.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    expect(
      await pin.evaluate((el) => getComputedStyle(el).outlineStyle),
      'tabbing to it drew no ring',
    ).not.toBe('none');
  });

  test('the skip link is out of the way until it is needed', async ({ page }) => {
    // Checked on the landing page rather than the vault: the skip link lives in
    // the root layout so it is on every page, and this is the one where nothing
    // else has taken focus first.
    await page.goto('/');

    const link = page.getByTestId('skip-link');
    const offscreen = await link.evaluate((el) => el.getBoundingClientRect().right < 0);
    expect(offscreen, 'the skip link is on screen before anything focused it').toBe(true);

    await page.keyboard.press('Tab');
    await expect(link).toBeFocused();
    expect(await link.evaluate((el) => el.getBoundingClientRect().left)).toBeGreaterThanOrEqual(0);
  });

  test('the skip link lands on the content', async ({ page }) => {
    await page.goto('/');

    await page.keyboard.press('Tab');
    await expect(page.getByTestId('skip-link')).toBeFocused();
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/#main$/);
    await expect(page.locator('main#main')).toHaveCount(1);
  });

  test('the login form can be filled and submitted by keyboard alone', async ({ page }) => {
    const email = await openVault(page, 'kbd-login');
    await page.goto('/login');

    await page.getByLabel('email').focus();
    await page.keyboard.type(email);
    await page.keyboard.press('Tab');
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
  });
});
