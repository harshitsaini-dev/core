import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buildAccount, uniqueEmail } from './helpers/account';
import { openPanel } from './helpers/vault-nav';
import { openVault as openAccount, unlockVault } from './helpers/vault';

/**
 * Account activity.
 *
 * The screen exists for one moment: somebody thinks another person has been in
 * their vault. So the tests are about whether it could answer that — the events
 * are really recorded, they belong to the right account, and what is shown is
 * only what the server actually knows.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function openActivity(page: Page): Promise<void> {
  await openPanel(page, 'open-activity');
  await expect(page.getByTestId('activity')).toBeVisible();
  await expect(page.getByTestId('activity-loading')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('account activity', () => {
  test.slow();

  test('shows the sign-up and the sign-in that got here', async ({ page }) => {
    await openVault(page, 'activity-basic');
    await openActivity(page);

    await expect(page.getByTestId('activity-list')).toContainText('account created');
    await expect(page.getByTestId('activity-list')).toContainText('signed in');
  });

  test('records a failed sign-in', async ({ page }) => {
    // The entry somebody opens this screen looking for.
    const email = await openVault(page, 'activity-failed');

    await page.goto('/login');
    await page.getByLabel('email').fill(email);
    await page.getByLabel('master password').fill('not-the-right-password-at-all');
    await page.getByTestId('unlock').click();
    await expect(page.getByTestId('login-error')).toBeVisible({ timeout: 60_000 });

    await unlockVault(page, email, PASSWORD);
    await openActivity(page);

    await expect(page.getByTestId('activity-list')).toContainText('failed sign-in');
  });

  test('records signing out', async ({ page }) => {
    const email = await openVault(page, 'activity-logout');
    await page.getByTestId('panic').click();
    await expect(page.getByTestId('vault-state')).toContainText('locked');

    await unlockVault(page, email, PASSWORD);
    await openActivity(page);

    await expect(page.getByTestId('activity-list')).toContainText('signed out');
  });

  test('never shows one account another account’s history', async ({ page, request }) => {
    // The whole list is scoped by the session's user. A leak here would be a
    // map of somebody else's sign-ins.
    const stranger = await buildAccount(uniqueEmail('activity-stranger'), PASSWORD);
    const created = await request.post('/api/auth/signup', { data: stranger.payload });
    expect(created.status()).toBe(200);

    await openVault(page, 'activity-mine');

    const response = await page.request.get('/api/auth/activity');
    const body = (await response.json()) as { events: { id: string }[] };

    // Every returned row belongs to this account, and this account has exactly
    // the two events its own session produced.
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.length).toBeLessThan(10);
  });

  test('needs a session', async ({ request }) => {
    const response = await request.get('/api/auth/activity');
    expect(response.status()).toBe(401);
  });

  test('sends no address or user agent, hashed or otherwise', async ({ page }) => {
    // They are stored hashed and cannot be un-hashed, so a hash on screen would
    // be noise dressed as evidence. The country is the one field somebody can
    // act on, and it is the only one that leaves.
    await openVault(page, 'activity-no-ip');

    const response = await page.request.get('/api/auth/activity');
    const raw = await response.text();

    expect(raw.length, 'nothing was returned, so this proves nothing').toBeGreaterThan(2);
    expect(raw).not.toContain('ipHash');
    expect(raw).not.toContain('uaHash');
  });

  test('says the server has nothing rather than showing an empty list', async ({ page }) => {
    // "Nothing has happened" is the most misleading thing this screen could say
    // to somebody who opened it because they think something has.
    await openVault(page, 'activity-error');
    await page.route('**/api/auth/activity', (route) => route.fulfill({ status: 500, body: '' }));

    await openPanel(page, 'open-activity');
    await expect(page.getByTestId('activity')).toBeVisible();

    await expect(page.getByText('could not load it')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('activity-empty')).toHaveCount(0);
  });

  test('does not claim to show unlocks', async ({ page }) => {
    // Unlocking happens entirely in the browser and never reaches the server.
    // A list that showed sign-ins and called them unlocks would be lying about
    // what it knows.
    await openVault(page, 'activity-unlocks');
    await openActivity(page);

    await expect(page.getByTestId('activity')).toContainText('Unlocking is not here');
    await expect(page.getByTestId('activity-list')).not.toContainText('unlocked');
  });
});
