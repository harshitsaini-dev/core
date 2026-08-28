import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Cards, identities and SSH keys.
 *
 * All three were already modelled — the schema, `emptyItem` and `itemSubtitle`
 * have handled five types since Phase 3 — and the form offered two of them. So
 * these tests are partly about the types working and partly about the list
 * showing the right amount: enough to tell one card from another, and no more.
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

test.describe('card items', () => {
  test.slow();

  test('stores a card and shows only the last four digits', async ({ page }) => {
    // A number, an expiry and a CVV together are the card. The last four are
    // how people tell cards apart and are printed on the receipt anyway.
    await openVault(page, 'card');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-card').click();
    await page.getByTestId('item-title').fill('Travel card');
    await page.getByTestId('card-holder').fill('A Person');
    await page.getByTestId('card-number').fill('4111 1111 1111 1234');
    await page.getByTestId('card-expiry').fill('01/30');
    await page.getByTestId('card-cvv').fill('999');
    await page.getByTestId('item-save').click();

    const row = page.getByTestId('item-row');
    await expect(row).toContainText('Travel card');
    await expect(row).toContainText('1234');
    await expect(row).not.toContainText('4111');
    await expect(row).not.toContainText('999');
  });

  test('strips the spaces people type from the card', async ({ page }) => {
    await openVault(page, 'card-spaces');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-card').click();
    await page.getByTestId('item-title').fill('Card');
    await page.getByTestId('card-number').fill('4111 1111 1111 1234');
    await page.getByTestId('item-save').click();

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('card-number')).toHaveValue('4111111111111234');
  });

  test('masks the CVV and the PIN while they are typed', async ({ page }) => {
    await openVault(page, 'card-masked');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-card').click();

    await expect(page.getByTestId('card-cvv')).toHaveAttribute('type', 'password');
    await expect(page.getByTestId('card-pin')).toHaveAttribute('type', 'password');
  });
});

test.describe('identity items', () => {
  test.slow();

  test('stores an identity and lists it by email', async ({ page }) => {
    await openVault(page, 'identity');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-identity').click();
    await page.getByTestId('item-title').fill('Home');
    await page.getByTestId('identity-name').fill('A Person');
    await page.getByTestId('identity-email').fill('me@example.com');
    await page.getByTestId('identity-address').fill('12 Some Street\nSome Town');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-row')).toContainText('Home');
    await expect(page.getByTestId('item-row')).toContainText('me@example.com');
  });

  test('keeps a multi-line address exactly', async ({ page }) => {
    await openVault(page, 'identity-address');
    const address = '12 Some Street\nSome Town\nAB1 2CD';

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-identity').click();
    await page.getByTestId('item-title').fill('Home');
    await page.getByTestId('identity-address').fill(address);
    await page.getByTestId('item-save').click();

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('identity-address')).toHaveValue(address);
  });
});

test.describe('ssh key items', () => {
  test.slow();

  const PRIVATE_KEY =
    '-----BEGIN OPENSSH PRIVATE KEY-----\nline two\nline three\n-----END OPENSSH PRIVATE KEY-----';

  async function storeKey(page: Page): Promise<void> {
    await page.getByTestId('new-item').click();
    await page.getByTestId('type-ssh').click();
    await page.getByTestId('item-title').fill('Deploy key');
    await page.getByTestId('ssh-host').fill('git@github.com');
    await page.getByTestId('ssh-public').fill('ssh-ed25519 AAAAC3NzaC1 me@example.com');
    await page.getByTestId('ssh-private').fill(PRIVATE_KEY);
    await page.getByTestId('ssh-passphrase').fill('a passphrase');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-list')).toContainText('Deploy key');
  }

  test('stores a key and lists it by host', async ({ page }) => {
    await openVault(page, 'ssh');
    await storeKey(page);

    await expect(page.getByTestId('item-row')).toContainText('git@github.com');
  });

  test('keeps the line breaks, which are load-bearing', async ({ page }) => {
    // A private key with its newlines collapsed is not a private key.
    await openVault(page, 'ssh-newlines');
    await storeKey(page);

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('ssh-private')).toHaveValue(PRIVATE_KEY);
  });

  test('never puts the private key in the list', async ({ page }) => {
    await openVault(page, 'ssh-private');
    await storeKey(page);

    const list = page.getByTestId('item-list');
    await expect(list).not.toContainText('BEGIN OPENSSH');
    await expect(list).not.toContainText('a passphrase');
  });

  test('nothing reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'ssh-zk');
    await storeKey(page);
    await expect(page.getByTestId('connection-status')).toContainText('synced');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('BEGIN OPENSSH');
      expect(body).not.toContain('a passphrase');
      expect(body).not.toContain('git@github.com');
    }
  });
});

test.describe('the type selector', () => {
  test.slow();

  test('offers every type the vault can store', async ({ page }) => {
    // It offered two of the five the schema has models for, which is the kind
    // of gap nothing fails on.
    await openVault(page, 'types');
    await page.getByTestId('new-item').click();

    for (const type of ['login', 'note', 'card', 'identity', 'ssh']) {
      await expect(page.getByTestId(`type-${type}`), type).toBeVisible();
    }
  });

  test('the type is fixed once an item exists', async ({ page }) => {
    // Switching would silently drop whichever fields the other type lacks.
    await openVault(page, 'types-locked');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-card').click();
    await page.getByTestId('item-title').fill('Card');
    await page.getByTestId('item-save').click();

    await page.getByTestId('edit-item').click();
    await expect(page.getByTestId('type-login')).toHaveCount(0);
    await expect(page.getByTestId('card-number')).toBeVisible();
  });

  test('each type keeps its own fields', async ({ page }) => {
    await openVault(page, 'types-fields');
    await page.getByTestId('new-item').click();

    await page.getByTestId('type-card').click();
    await expect(page.getByTestId('card-number')).toBeVisible();
    await expect(page.getByTestId('ssh-private')).toHaveCount(0);

    await page.getByTestId('type-ssh').click();
    await expect(page.getByTestId('ssh-private')).toBeVisible();
    await expect(page.getByTestId('card-number')).toHaveCount(0);
  });
});

test.describe('password age', () => {
  test.slow();

  test('shows when a password was set', async ({ page }) => {
    await openVault(page, 'age');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('GitHub');
    await page.getByTestId('item-password').fill('a-password');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-password-age')).toContainText('set today');
  });

  test('does not restamp a password that was not changed', async ({ page }) => {
    // Opening an item and saving it must not make an old password look new,
    // or the age is a record of when somebody last looked at the item.
    await openVault(page, 'age-untouched');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('GitHub');
    await page.getByTestId('item-password').fill('a-password');
    await page.getByTestId('item-save').click();

    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-username').fill('me@example.com');
    await page.getByTestId('item-save').click();

    // Still today, because the item is new — what matters is that the value did
    // not change, which the unit tests cover at other ages.
    await expect(page.getByTestId('item-password-age')).toContainText('set today');
    await expect(page.getByTestId('item-row')).toContainText('me@example.com');
  });

  test('says nothing about age for an item with no password', async ({ page }) => {
    await openVault(page, 'age-none');

    await page.getByTestId('new-item').click();
    await page.getByTestId('type-note').click();
    await page.getByTestId('note-body').fill('No password here.');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-password-age')).toHaveCount(0);
  });

  test('never tells anybody to change it', async ({ page }) => {
    // Scheduled rotation is advice its own authors withdrew. The row reports a
    // number; it does not nag.
    await openVault(page, 'age-no-nag');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('GitHub');
    await page.getByTestId('item-password').fill('a-password');
    await page.getByTestId('item-save').click();

    const text = (await page.getByTestId('item-row').innerText()).toLowerCase();
    expect(text).not.toContain('expired');
    expect(text).not.toContain('too old');
  });
});

test.describe('item history', () => {
  test.slow();

  async function makeAndEdit(page: Page): Promise<void> {
    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Before');
    await page.getByTestId('item-password').fill('first-password');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-row-title')).toContainText('Before');

    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-title').fill('After');
    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('item-row-title')).toContainText('After');
  }

  test('records what an edit replaced', async ({ page }) => {
    await openVault(page, 'item-history');
    await makeAndEdit(page);

    await page.getByTestId('item-history').click();
    await expect(page.getByTestId('item-version')).toHaveCount(1);
    await expect(page.getByTestId('item-version')).toContainText('Before');
  });

  test('never shows a stored password', async ({ page }) => {
    // A history panel printing old passwords would be a list of every password
    // somebody has ever used, sitting open on the screen.
    await openVault(page, 'item-history-secret');
    await makeAndEdit(page);

    await page.getByTestId('item-history').click();
    await expect(page.getByTestId('item-history-list')).toBeVisible();
    await expect(page.getByTestId('item-history-list')).not.toContainText('first-password');
  });

  test('says so when there is nothing yet', async ({ page }) => {
    await openVault(page, 'item-history-empty');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Untouched');
    await page.getByTestId('item-save').click();

    await page.getByTestId('item-history').click();
    await expect(page.getByTestId('item-history-empty')).toBeVisible();
  });

  test('does not record a save that changed nothing', async ({ page }) => {
    await openVault(page, 'item-history-noop');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Same');
    await page.getByTestId('item-save').click();

    await page.getByTestId('edit-item').click();
    await page.getByTestId('item-save').click();

    await page.getByTestId('item-history').click();
    await expect(page.getByTestId('item-history-empty')).toBeVisible();
  });

  test('restores an earlier version, and the restore is undoable', async ({ page }) => {
    await openVault(page, 'item-history-restore');
    await makeAndEdit(page);

    await page.getByTestId('item-history').click();
    await page.getByTestId('item-version-restore').first().click();

    await expect(page.getByTestId('item-row-title')).toContainText('Before');
    // The version the restore replaced is recorded in turn.
    await expect(page.getByTestId('item-version')).toHaveCount(2);
  });
});
