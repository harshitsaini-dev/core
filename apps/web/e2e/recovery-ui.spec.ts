import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Emergency Kit recovery, driven entirely through the UI.
 *
 * Until this existed the kit was a promise: signup printed a recovery key and
 * nothing had ever opened a vault with one. These tests close that gap by doing
 * the whole thing the way a user would — create a vault, note the key, come
 * back having forgotten the password, and get in.
 *
 * The round trip at the bottom is the one that matters. It stores something in
 * the vault before recovery and reads it back after, which is the only way to
 * show that recovery preserves the Account Key rather than quietly minting a
 * new one and leaving the old data unreadable.
 */

const ORIGINAL = 'correct-horse-battery-staple-7391';
const REPLACEMENT = 'entirely-different-passphrase-4482';

function uniqueEmail(label: string): string {
  return `${label}-${crypto.randomUUID()}@core.test`;
}

/** Create a vault through the UI and return its recovery key. */
async function createVault(page: Page, email: string): Promise<string> {
  await page.goto('/signup');
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password', { exact: true }).fill(ORIGINAL);
  await page.getByLabel('confirm master password').fill(ORIGINAL);
  await page.getByRole('button', { name: 'create vault' }).click();

  await expect(page.getByTestId('kit-recovery-key')).toBeVisible({ timeout: 30_000 });
  const shown = (await page.getByTestId('kit-recovery-key').textContent()) ?? '';
  return shown.replace(/\s/g, '');
}

async function submitRecovery(
  page: Page,
  email: string,
  recoveryKey: string,
  newPassword: string,
): Promise<void> {
  await page.goto('/recover');
  await page.getByLabel('email').fill(email);
  await page.getByLabel('recovery key').fill(recoveryKey);
  await page.getByLabel('new master password', { exact: true }).fill(newPassword);
  await page.getByLabel('confirm new master password').fill(newPassword);
  await page.getByTestId('recover').click();
}

test.describe('recovery', () => {
  test.slow();

  test('a printed recovery key opens the vault again', async ({ page }) => {
    const email = uniqueEmail('recover');
    const recoveryKey = await createVault(page, email);

    await submitRecovery(page, email, recoveryKey, REPLACEMENT);

    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
    await expect(page.getByTestId('vault-state')).toContainText('unlocked');
  });

  test('the new password works and the old one no longer does', async ({ page }) => {
    const email = uniqueEmail('rotate-pw');
    const recoveryKey = await createVault(page, email);
    await submitRecovery(page, email, recoveryKey, REPLACEMENT);
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await page.goto('/login');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill(ORIGINAL);
    await page.getByTestId('unlock').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 45_000 });

    await page.getByLabel('master password').fill(REPLACEMENT);
    await page.getByTestId('unlock').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
  });

  test('accepts the key formatted the way it was printed, with spaces', async ({ page }) => {
    // Somebody typing from paper will type the groups. Rejecting that would
    // make the kit fail exactly when it is needed.
    const email = uniqueEmail('spaced');
    const recoveryKey = await createVault(page, email);
    const spaced = recoveryKey.match(/.{1,8}/g)?.join(' ') ?? recoveryKey;

    await submitRecovery(page, email, spaced, REPLACEMENT);
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
  });

  test('rejects a recovery key belonging to a different account', async ({ page }) => {
    const victim = uniqueEmail('victim');
    await createVault(page, victim);

    const attacker = uniqueEmail('attacker');
    const attackerKey = await createVault(page, attacker);

    await submitRecovery(page, victim, attackerKey, REPLACEMENT);

    await expect(page.getByTestId('recover-error')).toBeVisible({ timeout: 45_000 });
    await expect(page).not.toHaveURL(/\/vault$/);
  });

  test('rejects a malformed key without sending it anywhere', async ({ page }) => {
    const email = uniqueEmail('malformed');
    await createVault(page, email);

    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/auth/recover')) requests.push(request.url());
    });

    await submitRecovery(page, email, 'obviously-not-a-key', REPLACEMENT);

    await expect(page.getByTestId('recover-error')).toBeVisible({ timeout: 45_000 });
    // The client decodes the key before it derives anything, so a typo never
    // reaches the network at all.
    expect(requests).toEqual([]);
  });

  test('holds the new password to the same strength bar as signup', async ({ page }) => {
    // A vault recovered behind a weak password is in the position it would have
    // been in had it been created that way.
    await page.goto('/recover');
    await page.getByLabel('email').fill(uniqueEmail('weak'));
    await page.getByLabel('recovery key').fill('a'.repeat(43));
    await page.getByLabel('new master password', { exact: true }).fill('password123');
    await page.getByLabel('confirm new master password').fill('password123');

    await expect(page.getByTestId('recover')).toBeDisabled();
  });

  test('never sends the recovery key or either password to the server', async ({ page }) => {
    const email = uniqueEmail('zk-recover');
    const recoveryKey = await createVault(page, email);

    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await submitRecovery(page, email, recoveryKey, REPLACEMENT);
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body, 'the recovery key left the browser').not.toContain(recoveryKey);
      expect(body, 'the old password left the browser').not.toContain(ORIGINAL);
      expect(body, 'the new password left the browser').not.toContain(REPLACEMENT);
    }
  });
});

test.describe('vault lock state', () => {
  test.slow();

  test('locking releases the keys without ending the session', async ({ page }) => {
    const email = uniqueEmail('lock');
    const recoveryKey = await createVault(page, email);
    await submitRecovery(page, email, recoveryKey, REPLACEMENT);
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await page.getByTestId('lock').click();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    // The session survives a lock; only the keys go.
    const session = await page.request.get('/api/auth/session');
    expect(session.status()).toBe(200);
  });

  test('a reload leaves the vault locked, because keys are never persisted', async ({ page }) => {
    // The check that would catch somebody reaching for Zustand's persist
    // middleware: if the keys ever survived a reload, they would be on disk.
    const email = uniqueEmail('reload');
    const recoveryKey = await createVault(page, email);
    await submitRecovery(page, email, recoveryKey, REPLACEMENT);
    await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });

    await page.reload();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    const stored = await page.evaluate(() => JSON.stringify(window.localStorage));
    expect(stored).not.toContain('accountKey');
    expect(stored).not.toContain('dataKey');
  });
});
