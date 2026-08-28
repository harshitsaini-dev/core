import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * The generator.
 *
 * Two kinds of assertion here. The ordinary ones check that the options do what
 * they say — a length that is not honoured is a password weaker than the one
 * somebody believes they asked for, and it fails silently.
 *
 * The rest are about the history, which is a list of plaintext secrets held in
 * memory. Those tests are about where it must *not* end up: not in storage, and
 * not still there after a lock.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function openGenerator(page: Page): Promise<void> {
  await page.getByTestId('open-generator').click();
  await expect(page.getByTestId('generator')).toBeVisible();
}

/** The value on screen, which is masked until it is asked for. */
async function shown(page: Page): Promise<string> {
  await page.getByTestId('generate-reveal').click();
  const value = await page.getByTestId('generated-value').innerText();
  await page.getByTestId('generate-reveal').click();
  return value;
}

async function pick(page: Page, mode: string): Promise<void> {
  await page.getByRole('radio', { name: mode, exact: true }).check();
}

test.describe('generator', () => {
  test.slow();

  test('does not paint a password on screen until it is asked for', async ({ page }) => {
    // The one place in the app that would otherwise display a live secret the
    // moment a panel opens.
    await openVault(page, 'gen-hidden');
    await openGenerator(page);

    await expect(page.getByTestId('generated-value')).toContainText('•');
    await page.getByTestId('generate-reveal').click();
    await expect(page.getByTestId('generated-value')).not.toContainText('•');
  });

  test('regenerating gives something different', async ({ page }) => {
    await openVault(page, 'gen-again');
    await openGenerator(page);

    const first = await shown(page);
    await page.getByTestId('generate-again').click();
    const second = await shown(page);

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThan(0);
  });

  test('honours the length', async ({ page }) => {
    // A length the generator ignores produces a weaker password than the person
    // asking believes they have, and nothing on screen says so.
    await openVault(page, 'gen-length');
    await openGenerator(page);

    await page.getByTestId('generate-length').fill('32');
    await expect(page.getByTestId('generate-length-value')).toHaveText('32');
    expect(await shown(page)).toHaveLength(32);

    await page.getByTestId('generate-length').fill('12');
    expect(await shown(page)).toHaveLength(12);
  });

  test('leaves out the classes that are switched off', async ({ page }) => {
    await openVault(page, 'gen-classes');
    await openGenerator(page);

    await page.getByTestId('generate-length').fill('40');
    await page.getByTestId('generate-uppercase').uncheck();
    await page.getByTestId('generate-digits').uncheck();
    await page.getByTestId('generate-symbols').uncheck();

    const value = await shown(page);
    expect(value).toMatch(/^[a-z]+$/);
  });

  test('never emits an ambiguous character', async ({ page }) => {
    // The reason the alphabet is trimmed: this project prints an Emergency Kit,
    // and a 1 read as an l is a vault nobody can open.
    await openVault(page, 'gen-ambiguous');
    await openGenerator(page);

    await page.getByTestId('generate-length').fill('64');
    for (let round = 0; round < 5; round += 1) {
      await page.getByTestId('generate-again').click();
      expect(await shown(page)).not.toMatch(/[lI1O0]/);
    }
  });

  test('produces every shape it offers', async ({ page }) => {
    await openVault(page, 'gen-shapes');
    await openGenerator(page);

    await pick(page, 'passphrase');
    expect(await shown(page)).toMatch(/^[a-z]+(-[a-z]+){5}$/);

    await pick(page, 'uuid');
    expect(await shown(page)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    await pick(page, 'hex');
    expect(await shown(page)).toMatch(/^[0-9a-f]{64}$/);

    await pick(page, 'base64url');
    // url-safe: these end up in `.env` files and query strings.
    expect(await shown(page)).toMatch(/^[A-Za-z0-9_-]+$/);

    await pick(page, 'api key');
    expect(await shown(page)).toHaveLength(32);
  });

  test('keeps what it generated this session', async ({ page }) => {
    // For the password pasted into a signup form and then regenerated before
    // saving, which is otherwise unrecoverable.
    await openVault(page, 'gen-history');
    await openGenerator(page);

    const first = await shown(page);
    await page.getByTestId('generate-again').click();

    // Index 1, not 0: the newest is at the top, and the one being looked for
    // here is the value from before the regenerate.
    await expect(page.getByTestId('history-value').nth(1)).toContainText('•');
    await page.getByTestId('history-reveal').nth(1).click();
    await expect(page.getByTestId('history-value').nth(1)).toHaveText(first);
  });

  test('writes nothing it generated to storage', async ({ page }) => {
    // The assertion this feature turns on. A history in `localStorage` would be
    // a list of fresh passwords in the clear, outside the vault and outside the
    // encrypted cache.
    await openVault(page, 'gen-not-stored');
    await openGenerator(page);

    const value = await shown(page);
    await page.getByTestId('generate-again').click();

    const stored = await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    );
    expect(stored.length, 'nothing was read, so this proves nothing').toBeGreaterThan(0);
    expect(stored).not.toContain(value);
  });

  test('forgets everything when the vault locks', async ({ page }) => {
    // Locking is supposed to end access to secrets. A list of freshly generated
    // ones surviving it would be a hole in that exact control.
    const email = await openVault(page, 'gen-lock');
    await openGenerator(page);

    const value = await shown(page);
    await page.getByTestId('generate-again').click();
    await page.getByTestId('history-reveal').nth(1).click();
    await expect(page.getByTestId('history-value').nth(1)).toHaveText(value);

    // Back to the list first: the footer that holds `lock` belongs to the list
    // view, so it is not on screen while a panel is open.
    await page.getByTestId('generator-back').click();
    await page.getByTestId('lock').click();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    /*
     * Then back in, without a page load.
     *
     * The first version of this read the page text after locking and found the
     * value gone — which proved nothing, because the panel is not rendered on a
     * locked vault either way. It passed with the clearing removed.
     *
     * The locked screen navigates with `router.push`, so the JavaScript context
     * and every store in it survive. Coming back in and finding the list empty
     * is the only thing that distinguishes a cleared store from a hidden one.
     */
    await page.getByTestId('go-unlock').click();
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(PASSWORD);
    await page.getByTestId('unlock').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await openGenerator(page);

    /*
     * Read one row at a time, revealing and re-masking as it goes.
     *
     * The panel only ever reveals one row, by design, so a loop that clicks
     * every reveal and then reads the list gets one plain row and the rest in
     * bullets — which is how the first attempt at this passed with the clearing
     * removed. The values are compared, not the row count: opening the panel
     * generates one of its own, and React's development double-mount makes the
     * exact number unreliable.
     */
    const reveals = page.getByTestId('history-reveal');
    const values: string[] = [];

    for (let row = 0; row < (await reveals.count()); row += 1) {
      await reveals.nth(row).click();
      values.push(await page.getByTestId('history-value').nth(row).innerText());
      await reveals.nth(row).click();
    }

    expect(values.length, 'no rows were read, so this proves nothing').toBeGreaterThan(0);
    expect(values).not.toContain(value);
  });

  test('never sends a generated value anywhere', async ({ page }) => {
    // Listening from before the account exists, so the sign-in traffic proves
    // the listener works. Attached after it, this test captured nothing at all
    // — the generator makes no requests — and the assertion below would have
    // held over an empty string.
    const urls: string[] = [];
    const bodies: string[] = [];
    page.on('request', (request) => {
      urls.push(request.url());
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'gen-not-sent');
    await openGenerator(page);
    const value = await shown(page);
    await page.getByTestId('generate-again').click();

    expect(urls.length, 'no requests were seen, so this proves nothing').toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain(value);
  });
});
