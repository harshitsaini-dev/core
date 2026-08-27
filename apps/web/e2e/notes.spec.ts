import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Notes.
 *
 * Free-form text, encrypted like everything else. The tests worth having here
 * are about what happens to the text: that it comes back exactly as written,
 * and that it is never interpreted as markup.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

async function openVault(page: Page, label: string): Promise<void> {
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
}

async function writeNote(page: Page, body: string, title = ''): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('type-note').click();
  if (title) await page.getByTestId('note-title').fill(title);
  await page.getByTestId('note-body').fill(body);
  await page.getByTestId('item-save').click();
}

test.describe('notes', () => {
  test.slow();

  test('stores a note and lists it', async ({ page }) => {
    await openVault(page, 'note');
    await writeNote(page, 'Remember the milk.', 'Shopping');

    await expect(page.getByTestId('item-list')).toContainText('Shopping');
    await expect(page.getByTestId('item-row')).toContainText('note');
  });

  test('takes the first line as the title when none is given', async ({ page }) => {
    // Writing straight into the body and pressing save is the natural way to
    // use a notes app; refusing it because a separate field is empty would be
    // the wrong lesson to teach.
    await openVault(page, 'note-autotitle');
    await writeNote(page, 'Server rebuild steps\n\n1. Snapshot the volume');

    await expect(page.getByTestId('item-row-title')).toContainText('Server rebuild steps');
  });

  test('keeps the text exactly as written, line breaks and all', async ({ page }) => {
    const body = 'first line\n\nthird line\n    indented\ttabbed';

    await openVault(page, 'note-exact');
    await writeNote(page, body, 'Exactness');

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('note-body')).toHaveValue(body);
  });

  test('shows the note without interpreting it as markup', async ({ page }) => {
    // The reason notes are rendered as text: a note is the easiest place for
    // hostile content to arrive, and this origin holds the vault keys.
    await openVault(page, 'note-markup');
    await writeNote(page, '# Heading\n<b>bold</b> <img src=x onerror=alert(1)>', 'Markup');

    await page.getByTestId('note-body-view').click();
    const view = page.getByTestId('note-body-view');

    // The angle brackets survive as characters rather than becoming elements.
    await expect(view).toContainText('<b>bold</b>');
    await expect(view).toContainText('# Heading');
    expect(await view.locator('b').count()).toBe(0);
    expect(await view.locator('img').count()).toBe(0);
  });

  test('finds a note by its title', async ({ page }) => {
    await openVault(page, 'note-search');
    await writeNote(page, 'Contents that should not match.', 'Wifi password hint');
    await writeNote(page, 'Something else entirely.', 'Unrelated');

    await page.getByTestId('search').fill('wifi');
    await expect(page.getByTestId('item-row')).toHaveCount(1);
    await expect(page.getByTestId('item-row-title')).toContainText('Wifi');
  });

  test('a long note survives a round trip', async ({ page }) => {
    const body = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');

    await openVault(page, 'note-long');
    await writeNote(page, body, 'Long');
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('note-body')).toHaveValue(body);
  });

  test('the text never reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'note-zk');
    await writeNote(page, 'a-secret-written-in-a-note', 'PrivateThoughts');
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('a-secret-written-in-a-note');
      expect(body).not.toContain('PrivateThoughts');
    }
  });

  test('the type cannot be changed once an item exists', async ({ page }) => {
    // Switching would silently drop whichever fields the other type lacks.
    await openVault(page, 'note-locked-type');
    await writeNote(page, 'Fixed type.', 'Fixed');

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('type-login')).toHaveCount(0);
    await expect(page.getByTestId('note-body')).toBeVisible();
  });

  test('logins and notes coexist', async ({ page }) => {
    await openVault(page, 'note-mixed');

    await writeNote(page, 'A note.', 'MyNote');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-login').click();
    await page.getByTestId('item-title').fill('MyLogin');
    await page.getByTestId('item-password').fill('secret');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-list')).toContainText('MyNote');
    await expect(page.getByTestId('item-list')).toContainText('MyLogin');
    await expect(page.getByTestId('item-row')).toHaveCount(2);
  });
});
