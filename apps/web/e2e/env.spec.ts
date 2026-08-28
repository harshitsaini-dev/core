import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * The environment manager, through the browser.
 *
 * A `.env` file is a pile of production secrets, so most of what matters here
 * is what the screen does *not* show and what the network does not carry.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

async function openEnv(page: Page, label: string): Promise<string> {
  const email = uniqueEmail(label);

  await page.goto('/signup');
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password', { exact: true }).fill(PASSWORD);
  await page.getByLabel('confirm master password').fill(PASSWORD);
  await page.getByRole('button', { name: 'create vault' }).click();

  await expect(page.getByTestId('kit-acknowledge')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('kit-acknowledge').check();
  await page.getByTestId('kit-continue').click();

  await expect(page).toHaveURL(/\/login$/);
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(PASSWORD);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

  // Navigated from inside the app, not with `goto`. A full page load discards
  // the in-memory keys and lands on a locked screen — which is by design, and
  // is also why the vault reaches this page with router.push.
  await page.getByTestId('open-env').click();
  await expect(page).toHaveURL(/\/env$/);
  await expect(page.getByTestId('project-name')).toBeVisible();

  return email;
}

async function makeProject(page: Page, name: string): Promise<void> {
  await page.getByTestId('project-name').fill(name);
  await page.getByTestId('project-create').click();
  await expect(page.getByTestId('project-chip').filter({ hasText: name })).toBeVisible();
}

async function addVar(page: Page, key: string, value: string): Promise<void> {
  await page.getByTestId('var-key').fill(key);
  await page.getByTestId('var-value').fill(value);
  await page.getByTestId('var-add').click();
  await expect(page.getByTestId('var-list')).toContainText(key);
  await expect(page.getByTestId('env-status')).toContainText('saved');
}

test.describe('projects and environments', () => {
  test.slow();

  test('a new project starts with the three environments every project has', async ({ page }) => {
    // A project with none is a dead end: nowhere to put a variable and nothing
    // to look at.
    await openEnv(page, 'env-new');
    await makeProject(page, 'Checkout');

    const tabs = page.getByTestId('environment-tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(0)).toContainText('development');
    await expect(tabs.nth(2)).toContainText('production');
  });

  test('says so when there is nothing yet', async ({ page }) => {
    await openEnv(page, 'env-empty');
    await expect(page.getByTestId('env-empty')).toContainText('no projects yet');
  });

  test('adds an environment of its own', async ({ page }) => {
    await openEnv(page, 'env-add');
    await makeProject(page, 'Checkout');

    await page.getByTestId('environment-name').fill('preview');
    await page.getByTestId('environment-create').click();

    await expect(page.getByTestId('environment-tab')).toHaveCount(4);
  });

  test('keeps each environment’s variables apart', async ({ page }) => {
    await openEnv(page, 'env-separate');
    await makeProject(page, 'Checkout');

    await addVar(page, 'DEV_ONLY', 'yes');

    await page.getByTestId('environment-tab').nth(2).click();
    await expect(page.getByTestId('vars-empty')).toBeVisible();

    await page.getByTestId('environment-tab').nth(0).click();
    await expect(page.getByTestId('var-list')).toContainText('DEV_ONLY');
  });

  test('duplicates an environment with its values', async ({ page }) => {
    // The entire point: "staging is production with three things changed" is
    // how these are made, and an empty copy leaves somebody retyping forty
    // secrets by hand.
    await openEnv(page, 'env-duplicate');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://dev.example.com');

    await page.getByTestId('environment-duplicate').click();

    await expect(page.getByTestId('environment-tab')).toHaveCount(4);
    await expect(page.getByTestId('var-list')).toContainText('API_URL');
    await page.getByTestId('var-row-reveal').click();
    await expect(page.getByTestId('var-row-value')).toContainText('https://dev.example.com');
  });
});

test.describe('variables', () => {
  test.slow();
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('masks a value until it is asked for', async ({ page }) => {
    // The whole screen is a wall of secrets, and the normal reason to open it
    // is to copy one while sharing a screen.
    await openEnv(page, 'env-mask');
    await makeProject(page, 'Checkout');
    await addVar(page, 'STRIPE_SECRET_KEY', 'sk_live_abcdefgh1234');

    const value = page.getByTestId('var-row-value');
    await expect(value).not.toContainText('sk_live_abcdefgh');
    await expect(value).toContainText('1234');

    await page.getByTestId('var-row-reveal').click();
    await expect(value).toContainText('sk_live_abcdefgh1234');
  });

  test('reveals and re-masks everything at once', async ({ page }) => {
    await openEnv(page, 'env-reveal-all');
    await makeProject(page, 'Checkout');
    await addVar(page, 'ONE', 'first-value');
    await addVar(page, 'TWO', 'second-value');

    await page.getByTestId('reveal-all').click();
    await expect(page.getByTestId('var-list')).toContainText('first-value');
    await expect(page.getByTestId('var-list')).toContainText('second-value');

    await page.getByTestId('reveal-all').click();
    await expect(page.getByTestId('var-list')).not.toContainText('first-value');
  });

  test('edits a value in place', async ({ page }) => {
    await openEnv(page, 'env-edit');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://old.example.com');

    await page.getByTestId('var-row-edit-open').click();
    await page.getByTestId('var-row-edit').fill('https://new.example.com');
    await page.getByTestId('var-row-save').click();

    await page.getByTestId('var-row-reveal').click();
    await expect(page.getByTestId('var-row-value')).toContainText('https://new.example.com');
  });

  test('copies a value without naming it in the confirmation', async ({ page }) => {
    await openEnv(page, 'env-copy');
    await makeProject(page, 'Checkout');
    await addVar(page, 'SECRET', 'never-in-a-toast');

    await page.getByTestId('var-row-copy').click();

    await expect(page.getByTestId('toast')).toContainText('SECRET copied');
    await expect(page.getByTestId('toast')).not.toContainText('never-in-a-toast');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('never-in-a-toast');
  });

  test('refuses a name a shell could not source', async ({ page }) => {
    await openEnv(page, 'env-badkey');
    await makeProject(page, 'Checkout');

    await page.getByTestId('var-key').fill('9LIVES');
    await expect(page.getByTestId('var-key-error')).toBeVisible();
    await expect(page.getByTestId('var-add')).toBeDisabled();
  });

  test('removes a variable', async ({ page }) => {
    await openEnv(page, 'env-delete');
    await makeProject(page, 'Checkout');
    await addVar(page, 'TEMPORARY', 'x');

    await page.getByTestId('var-row-delete').click();
    await expect(page.getByTestId('vars-empty')).toBeVisible();
  });

  test('nothing readable reaches the server', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openEnv(page, 'env-zk');
    await makeProject(page, 'PaymentsProject');
    await addVar(page, 'STRIPE_SECRET_KEY', 'sk_live_do_not_leak');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('sk_live_do_not_leak');
      expect(body).not.toContain('STRIPE_SECRET_KEY');
      expect(body).not.toContain('PaymentsProject');
      expect(body).not.toContain('production');
    }
  });
});

test.describe('import and export', () => {
  test.slow();
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('imports a pasted .env', async ({ page }) => {
    await openEnv(page, 'env-import');
    await makeProject(page, 'Checkout');

    await page.getByTestId('open-import').click();
    await page
      .getByTestId('import-text')
      .fill('# a comment\nDATABASE_URL="postgres://localhost/db"\nexport DEBUG=true\n');
    await page.getByTestId('import-apply').click();

    await expect(page.getByTestId('var-row')).toHaveCount(2);
    await expect(page.getByTestId('var-list')).toContainText('DATABASE_URL');
    await expect(page.getByTestId('var-list')).toContainText('DEBUG');
  });

  test('an import updates rather than replacing', async ({ page }) => {
    // "Add the two new keys from staging" must not mean "lose everything else".
    await openEnv(page, 'env-import-merge');
    await makeProject(page, 'Checkout');
    await addVar(page, 'KEEP', 'untouched');
    await addVar(page, 'CHANGE', 'before');

    await page.getByTestId('open-import').click();
    await page.getByTestId('import-text').fill('CHANGE=after\nNEW=added\n');
    await page.getByTestId('import-apply').click();

    await expect(page.getByTestId('var-row')).toHaveCount(3);
    await page.getByTestId('reveal-all').click();
    await expect(page.getByTestId('var-list')).toContainText('untouched');
    await expect(page.getByTestId('var-list')).toContainText('after');
    await expect(page.getByTestId('var-list')).not.toContainText('before');
  });

  test('says how many lines it could not read', async ({ page }) => {
    await openEnv(page, 'env-import-skip');
    await makeProject(page, 'Checkout');

    await page.getByTestId('open-import').click();
    await page.getByTestId('import-text').fill('GOOD=yes\nthis is not a variable\n');
    await page.getByTestId('import-apply').click();

    await expect(page.getByTestId('toast')).toContainText('not understood');
  });

  test('copies the environment back out as a .env', async ({ page }) => {
    await openEnv(page, 'env-export');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://example.com');

    await page.getByTestId('copy-dotenv').click();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('API_URL=https://example.com');
  });

  test('copies shell exports for pasting into a terminal', async ({ page }) => {
    await openEnv(page, 'env-export-shell');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://example.com');

    await page.getByTestId('copy-shell').click();

    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('export API_URL=');
  });

  test('a round trip through .env changes nothing', async ({ page }) => {
    await openEnv(page, 'env-roundtrip');
    await makeProject(page, 'Checkout');

    const original = 'A=plain\nB="with space"\nC=""\nD="hash # inside"\n';

    await page.getByTestId('open-import').click();
    await page.getByTestId('import-text').fill(original);
    await page.getByTestId('import-apply').click();
    await expect(page.getByTestId('var-row')).toHaveCount(4);

    await page.getByTestId('copy-dotenv').click();
    const exported = await page.evaluate(() => navigator.clipboard.readText());

    // Re-importing what was exported must be a no-op, or every export/import
    // cycle would quietly corrupt a value.
    await page.getByTestId('open-import').click();
    await page.getByTestId('import-text').fill(exported);
    await page.getByTestId('import-apply').click();

    await expect(page.getByTestId('var-row')).toHaveCount(4);
    // The newest toast: the copy and the first import are still on screen.
    await expect(page.getByTestId('toast').last()).toContainText('0 variable(s) imported');
  });
});

test.describe('the vault lock reaches here too', () => {
  test.slow();

  test('locking empties the screen', async ({ page }) => {
    await openEnv(page, 'env-lock');
    await makeProject(page, 'Checkout');

    await page.getByTestId('lock').click();
    await expect(page.getByTestId('env-state')).toContainText('locked');
    await expect(page.getByTestId('project-chip')).toHaveCount(0);
  });
});

test.describe('files', () => {
  test.slow();

  test('downloads the environment as a .env file', async ({ page }) => {
    // Built in the tab from a blob. A download endpoint would mean sending
    // decrypted variables back to the one party this product keeps them from.
    await openEnv(page, 'env-download');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://example.com');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('download-dotenv').click(),
    ]);

    expect(download.suggestedFilename()).toBe('development.env');

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString('utf8')).toContain('API_URL=https://example.com');
  });

  test('accepts a .env dropped onto the import panel', async ({ page }) => {
    // How a `.env` actually arrives: it is already on disk, and the
    // alternative is opening it in an editor to copy out of.
    await openEnv(page, 'env-drop');
    await makeProject(page, 'Checkout');

    await page.getByTestId('open-import').click();

    await page.getByTestId('import-drop').evaluate((element) => {
      const file = new File(['DROPPED=yes\nSECOND=two\n'], '.env', { type: 'text/plain' });
      const transfer = new DataTransfer();
      transfer.items.add(file);

      element.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: transfer }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    });

    await expect(page.getByTestId('import-text')).toHaveValue(/DROPPED=yes/);

    await page.getByTestId('import-apply').click();
    await expect(page.getByTestId('var-row')).toHaveCount(2);
  });
});

test.describe('variable history', () => {
  test.slow();

  test('records the value a change replaced', async ({ page }) => {
    const calls: string[] = [];
    page.on('response', (response) => {
      if (response.url().includes('/api/env/')) {
        calls.push(response.request().method() + ' ' + response.status());
      }
    });

    await openEnv(page, 'env-history');
    await makeProject(page, 'Checkout');
    await addVar(page, 'API_URL', 'https://one.example.com');

    await page.getByTestId('var-row-edit-open').click();
    await page.getByTestId('var-row-edit').fill('https://two.example.com');
    await page.getByTestId('var-row-save').click();
    await expect(page.getByTestId('var-row-edit')).toHaveCount(0);

    await page.getByTestId('var-row-history').click();
    await expect(page.getByTestId('history-entry'), calls.join(', ')).toHaveCount(1, {
      timeout: 20_000,
    });
  });

  test('shows what moved, not just what it was', async ({ page }) => {
    // "It was postgres://old-host/db" is far less useful than seeing which part
    // of it changed.
    await openEnv(page, 'env-history-diff');
    await makeProject(page, 'Checkout');
    await addVar(page, 'DB', 'postgres://old-host/db');

    await page.getByTestId('var-row-edit-open').click();
    await page.getByTestId('var-row-edit').fill('postgres://new-host/db');
    await page.getByTestId('var-row-save').click();
    await expect(page.getByTestId('var-row-edit')).toHaveCount(0);

    await page.getByTestId('var-row-history').click();
    // Waited for rather than clicked straight away: the panel fetches, and the
    // control only exists once there is something to reveal.
    await expect(page.getByTestId('history-reveal')).toBeVisible();
    await page.getByTestId('history-reveal').click();

    const diff = page.getByTestId('history-diff');
    await expect(diff.locator('[data-kind="removed"]')).toContainText('old-host');
    await expect(diff.locator('[data-kind="added"]')).toContainText('new-host');
  });

  test('masks the old values until they are asked for', async ({ page }) => {
    // A rotated key is still valid until somebody revokes it, and the reason it
    // was rotated is often that it leaked.
    await openEnv(page, 'env-history-masked');
    await makeProject(page, 'Checkout');
    await addVar(page, 'TOKEN', 'sk_live_old_secret');

    await page.getByTestId('var-row-edit-open').click();
    await page.getByTestId('var-row-edit').fill('sk_live_new_secret');
    await page.getByTestId('var-row-save').click();
    // The row stays open until the save lands, so this is the barrier. The
    // status indicator is not one: it reads "saved" from the first save onward.
    await expect(page.getByTestId('var-row-edit')).toHaveCount(0);

    await page.getByTestId('var-row-history').click();
    await expect(page.getByTestId('history-reveal')).toBeVisible();
    await expect(page.getByTestId('history')).not.toContainText('sk_live_old_secret');

    await page.getByTestId('history-reveal').click();
    await expect(page.getByTestId('history-diff')).toContainText('sk_live_old_secret');
  });

  test('says so when there is nothing to show', async ({ page }) => {
    await openEnv(page, 'env-history-empty');
    await makeProject(page, 'Checkout');
    await addVar(page, 'NEVER_CHANGED', 'one');

    await page.getByTestId('var-row-history').click();
    await expect(page.getByTestId('history-empty')).toBeVisible();
  });

  test('does not record a save that changed nothing', async ({ page }) => {
    // Otherwise the history fills with entries identical to each other and the
    // one somebody is looking for is harder to find.
    await openEnv(page, 'env-history-noop');
    await makeProject(page, 'Checkout');
    await addVar(page, 'SAME', 'unchanged');

    await page.getByTestId('var-row-edit-open').click();
    await page.getByTestId('var-row-save').click();
    // The row stays open until the save lands, so this is the barrier. The
    // status indicator is not one: it reads "saved" from the first save onward.
    await expect(page.getByTestId('var-row-edit')).toHaveCount(0);

    await page.getByTestId('var-row-history').click();
    await expect(page.getByTestId('history-empty')).toBeVisible();
  });

  test('keeps every change in order', async ({ page }) => {
    await openEnv(page, 'env-history-order');
    await makeProject(page, 'Checkout');
    await addVar(page, 'STEP', 'one');

    for (const value of ['two', 'three']) {
      await page.getByTestId('var-row-edit-open').click();
      await page.getByTestId('var-row-edit').fill(value);
      await page.getByTestId('var-row-save').click();
      await expect(page.getByTestId('var-row-edit')).toHaveCount(0);
    }

    await page.getByTestId('var-row-history').click();
    await expect(page.getByTestId('history-entry')).toHaveCount(2);

    await page.getByTestId('history-reveal').click();
    // Newest first: the most recent previous value is "two".
    await expect(page.getByTestId('history-entry').first()).toContainText('two');
  });
});
