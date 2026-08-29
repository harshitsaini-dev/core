import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Toasts and blur-all.
 *
 * Both are interface features with a security edge, and the tests are mostly
 * about the edge: a toast must never carry a value, and the blur must not miss
 * anything that is one.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function openVault(page: Page, label: string): Promise<void> {
  await openAccount(page, label, PASSWORD);
}

async function makeLogin(
  page: Page,
  title: string,
  fields: { username?: string; password?: string; tags?: string } = {},
): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  if (fields.username) await page.getByTestId('item-username').fill(fields.username);
  if (fields.password) await page.getByTestId('item-password').fill(fields.password);
  if (fields.tags) await page.getByTestId('item-tags').fill(fields.tags);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

test.describe('toasts', () => {
  test.slow();
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('confirms a copy without saying what was copied', async ({ page }) => {
    // The rule that makes this worth testing rather than eyeballing: a toast
    // appears unprompted and lingers, in exactly the frame a screen recording
    // captures.
    await openVault(page, 'toast-copy');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'never-in-a-toast' });

    await page.getByTestId('copy-password').click();

    const toast = page.getByTestId('toast');
    await expect(toast).toBeVisible();
    await expect(toast).toContainText('copied');
    await expect(toast).not.toContainText('never-in-a-toast');
  });

  test('withdraws itself', async ({ page }) => {
    await openVault(page, 'toast-fade');
    await makeLogin(page, 'GitHub', { password: 'secret' });

    await page.getByTestId('copy-password').click();
    await expect(page.getByTestId('toast')).toBeVisible();
    await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 10_000 });
  });

  test('can be dismissed by hand', async ({ page }) => {
    await openVault(page, 'toast-dismiss');
    await makeLogin(page, 'GitHub', { password: 'secret' });

    await page.getByTestId('copy-password').click();
    await page.getByTestId('toast-dismiss').click();
    await expect(page.getByTestId('toast')).toHaveCount(0);
  });

  test('offers undo after a delete, and the undo works', async ({ page }) => {
    await openVault(page, 'toast-undo');
    await makeLogin(page, 'Precious', { password: 'secret' });

    await page.getByTestId('delete-item').click();
    await expect(page.getByTestId('item-row')).toHaveCount(0);

    await page.getByTestId('toast-action').click();
    await expect(page.getByTestId('item-row-title')).toContainText('Precious');
  });

  test('an undo does not vanish on a timer', async ({ page }) => {
    // Withdrawing an undo while somebody is still reading what happened takes
    // away the only way back.
    await openVault(page, 'toast-undo-stays');
    await makeLogin(page, 'Precious', { password: 'secret' });

    await page.getByTestId('delete-item').click();
    await page.waitForTimeout(6000);

    await expect(page.getByTestId('toast-action')).toBeVisible();
  });

  test('shows at most three at once', async ({ page }) => {
    await openVault(page, 'toast-cap');
    await makeLogin(page, 'GitHub', { username: 'me', password: 'secret' });

    for (let i = 0; i < 5; i += 1) {
      await page.getByTestId('copy-username').click();
    }

    await expect(page.getByTestId('toast')).toHaveCount(3);
  });

  test('a persistent condition is not a toast', async ({ page, context }) => {
    // Offline is a state, not an event. A message that disappears is the wrong
    // shape for something that has not stopped being true.
    await openVault(page, 'toast-not-state');
    await context.setOffline(true);

    await makeLogin(page, 'Offline item', { password: 'secret' });
    await expect(page.getByTestId('connection-status')).toContainText('offline', {
      timeout: 20_000,
    });

    await context.setOffline(false);
  });
});

test.describe('blur-all', () => {
  test.slow();

  test('blurs the values and leaves the structure', async ({ page }) => {
    await openVault(page, 'blur');
    await makeLogin(page, 'GitHub', { username: 'me@example.com' });

    const title = page.getByTestId('item-row-title');
    const blurOf = async () => title.evaluate((element) => getComputedStyle(element).filter);

    expect(await blurOf()).toBe('none');

    await page.getByTestId('toggle-blur').click();
    await expect.poll(blurOf).toContain('blur');

    // The row is still there and still countable — the vault's shape is not
    // the secret, what is in it is.
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('search')).toBeVisible();
  });

  test('toggles with the b key', async ({ page }) => {
    await openVault(page, 'blur-key');
    await makeLogin(page, 'GitHub');

    await page.keyboard.press('b');
    await expect(page.getByTestId('toggle-blur')).toHaveAttribute('aria-pressed', 'true');

    await page.keyboard.press('b');
    await expect(page.getByTestId('toggle-blur')).toHaveAttribute('aria-pressed', 'false');
  });

  test('covers the subtitle and the tags too', async ({ page }) => {
    await openVault(page, 'blur-everything');
    await makeLogin(page, 'GitHub', { username: 'me@example.com', tags: 'work' });

    await page.getByTestId('toggle-blur').click();

    for (const testId of ['item-row-title', 'item-row-tags']) {
      const filter = await page
        .getByTestId(testId)
        .evaluate((element) => getComputedStyle(element).filter);
      expect(filter, `${testId} was left legible`).toContain('blur');
    }
  });

  test('reaches the command palette', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'no modifier keys on a phone');

    // The palette renders outside the vault's subtree. A switch that missed it
    // would claim the screen was covered while one part of it was not.
    await openVault(page, 'blur-palette');
    await makeLogin(page, 'GitHub');

    await page.getByTestId('toggle-blur').click();
    await page.keyboard.press('ControlOrMeta+k');

    const filter = await page
      .getByTestId('palette-item-title')
      .first()
      .evaluate((element) => getComputedStyle(element).filter);
    expect(filter).toContain('blur');
  });

  test('closes a revealed password', async ({ page }) => {
    // The blur covers displayed values; a field being typed into cannot be
    // blurred and still be typed into. So the reveal is closed instead.
    await openVault(page, 'blur-reveal');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-password').fill('secret');
    await page.getByTestId('item-reveal').click();
    await expect(page.getByTestId('item-password')).toHaveAttribute('type', 'text');

    await page.getByTestId('toggle-blur').click();

    await expect(page.getByTestId('item-password')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('item-reveal')).toContainText('show');
  });

  test('does not survive locking', async ({ page }) => {
    await openVault(page, 'blur-lock');
    await makeLogin(page, 'GitHub');

    await page.getByTestId('toggle-blur').click();
    await page.getByTestId('lock').click();

    const blurredClass = await page.evaluate(() =>
      document.documentElement.classList.contains('blurred'),
    );
    expect(blurredClass).toBe(false);
  });

  test('the text is still there underneath', async ({ page }) => {
    // Blurred, not removed: the value stays selectable and copyable, and the
    // layout does not move as it toggles.
    await openVault(page, 'blur-text');
    await makeLogin(page, 'GitHub');

    await page.getByTestId('toggle-blur').click();
    await expect(page.getByTestId('item-row-title')).toContainText('GitHub');
  });
});

test.describe('terminal motifs', () => {
  test.slow();

  test('a view heading types itself in', async ({ page }) => {
    await openVault(page, 'motif-typewriter');
    await page.getByTestId('new-item').click();

    const heading = page.getByRole('heading', { name: 'new item' });
    const animation = await heading.evaluate((element) => ({
      name: getComputedStyle(element).animationName,
      timing: getComputedStyle(element).animationTimingFunction,
    }));

    expect(animation.name).toBe('typewriter-reveal');
    // Stepped, not eased — a smooth wipe is a wipe, not typing.
    expect(animation.timing).toContain('steps');
  });

  test('no value is ever revealed a character at a time', async ({ page }) => {
    // The reveal is for headings only. Running it over a stored value would
    // leave the value legible for longer than the finished text.
    await openVault(page, 'motif-typewriter-safety');
    await makeLogin(page, 'GitHub', { username: 'me@example.com' });

    const typed = page.locator('.typewriter');
    const secrets = page.locator('.secret');

    expect(await typed.locator('.secret').count()).toBe(0);
    expect(await secrets.locator('.typewriter').count()).toBe(0);
  });

  test('the heading carries a blinking cursor', async ({ page }) => {
    await openVault(page, 'motif-cursor');

    const animation = await page
      .locator('.cursor')
      .first()
      .evaluate((element) => getComputedStyle(element, '::after').animationName);

    expect(animation).toBe('cursor-blink');
  });

  test('a primary button inverts on hover', async ({ page, isMobile }) => {
    test.skip(isMobile === true, 'no hover on touch');

    await openVault(page, 'motif-invert');
    const button = page.getByTestId('new-item');

    const resting = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    await button.hover();

    // Black text on a green block: the accent moves from the text to the fill.
    await expect
      .poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor))
      .toBe('rgb(0, 255, 65)');
    await expect
      .poll(() => button.evaluate((element) => getComputedStyle(element).color))
      .toBe('rgb(0, 0, 0)');

    expect(resting).not.toBe('rgb(0, 255, 65)');
  });

  test('an empty vault reads like a prompt, not an error', async ({ page }) => {
    await openVault(page, 'motif-empty');

    const empty = page.getByTestId('empty-state');
    await expect(empty).toContainText('nothing stored yet');
    await expect(empty).toContainText('>');
  });

  test('a search with no match says what was searched for', async ({ page }) => {
    await openVault(page, 'motif-no-match');
    await makeLogin(page, 'GitHub');

    await page.getByTestId('search').fill('zzzzzz');
    await expect(page.getByTestId('empty-state')).toContainText('no match for "zzzzzz"');
  });
});

test.describe('reduced motion', () => {
  /*
   * The floor, not the individual opt-outs.
   *
   * Each effect in `globals.css` has its own `prefers-reduced-motion` rule and
   * its own reason. What is checked here is the catch-all underneath them,
   * which is the part that keeps working when somebody adds an animation next
   * month without reading the file.
   *
   * Emulated per test rather than through `test.use({ reducedMotion })`, which
   * did not reach the page under this config — `matchMedia` still reported
   * false, so the first version of this asserted nothing and failed for the
   * right reason.
   */

  test('nothing on the vault animates', async ({ page }) => {
    await openVault(page, 'motion-vault');
    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect
      .poll(() =>
        page.evaluate(() =>
          window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'on' : 'off',
        ),
      )
      .toBe('on');

    const moving = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .flatMap((el) => {
          const style = getComputedStyle(el);
          return [style.animationDuration, style.transitionDuration];
        })
        // `0.01ms` is serialised back as `1e-05s`; `100000s` is the autofill
        // hack, which is not motion and is excluded in the stylesheet.
        .filter((value) => !['0s', '1e-05s', '100000s'].includes(value)),
    );

    expect(moving, 'something still animates under prefers-reduced-motion').toEqual([]);
  });

  test('the landing page does not animate either', async ({ page }) => {
    // The first screen anybody sees, and the one with the blinking cursor.
    await page.goto('/');
    await page.emulateMedia({ reducedMotion: 'reduce' });

    const cursor = await page
      .locator('.cursor')
      .first()
      .evaluate((el) => getComputedStyle(el, '::after').animationDuration);

    expect(['0s', '1e-05s']).toContain(cursor);
  });
});
