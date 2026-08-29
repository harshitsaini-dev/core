import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buildAccount, uniqueEmail } from './helpers/account';
import { openPanel } from './helpers/vault-nav';
import { openVault as openAccount, unlockVault } from './helpers/vault';

/**
 * Open sessions, and ending them.
 *
 * The actionable half of the activity screen: noticing a sign-in from somewhere
 * unfamiliar is only useful if there is something to do about it.
 *
 * The assertions that matter are the ones about scope and about the current
 * session. A revoke endpoint that accepted somebody else's session id would let
 * anyone sign out any account, and a list that let you end the session you are
 * using would be a button that signs you out and looks like a mistake.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function openActivity(page: Page): Promise<void> {
  await openPanel(page, 'open-activity');
  await expect(page.getByTestId('activity')).toBeVisible();
  await expect(page.getByTestId('sessions-loading')).toHaveCount(0, { timeout: 30_000 });
}

test.describe('open sessions', () => {
  test.slow();

  test('lists the session in use and offers no way to end it', async ({ page }) => {
    // A button that signs you out of the browser you are looking at is a button
    // that only ever gets pressed by accident.
    await openVault(page, 'sessions-current');
    await openActivity(page);

    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect(page.getByTestId('sessions-list')).toContainText('this browser');
    await expect(page.getByTestId('revoke-session')).toHaveCount(0);
  });

  test('a second sign-in shows up, and can be ended', async ({ page, browser }) => {
    const email = await openVault(page, 'sessions-second');

    // A second browser context is a genuinely separate session: its own cookie
    // jar, its own token.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await unlockVault(otherPage, email, PASSWORD);

    await openActivity(page);
    await expect(page.getByTestId('session-row')).toHaveCount(2);

    await page.getByTestId('revoke-session').first().click();
    await expect(page.getByTestId('session-row')).toHaveCount(1, { timeout: 30_000 });

    // And the ended one really is ended, not just missing from a list.
    const check = await otherPage.request.get('/api/auth/activity');
    expect(check.status()).toBe(401);

    await other.close();
  });

  test('ending another session leaves this one working', async ({ page, browser }) => {
    const email = await openVault(page, 'sessions-keep-mine');

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await unlockVault(otherPage, email, PASSWORD);

    await openActivity(page);
    await page.getByTestId('revoke-session').first().click();
    await expect(page.getByTestId('session-row')).toHaveCount(1, { timeout: 30_000 });

    const mine = await page.request.get('/api/auth/activity');
    expect(mine.status()).toBe(200);

    await other.close();
  });

  test('cannot end somebody else’s session', async ({ page, request }) => {
    // The assertion this endpoint turns on. Without the ownership condition,
    // anyone holding any session could sign out any account they could name.
    const stranger = await buildAccount(uniqueEmail('sessions-stranger'), PASSWORD);
    expect((await request.post('/api/auth/signup', { data: stranger.payload })).status()).toBe(200);

    const strangerLogin = await request.post('/api/auth/login', {
      data: { email: stranger.payload.email, authKey: stranger.payload.authKey },
    });
    expect(strangerLogin.status()).toBe(200);

    const theirSessions = await request.get('/api/auth/sessions');
    const theirs = (await theirSessions.json()) as { sessions: { id: string }[] };
    const theirId = theirs.sessions[0]?.id;
    expect(theirId, 'the stranger has no session, so this proves nothing').toBeTruthy();

    await openVault(page, 'sessions-attacker');

    // 200 either way: a 404 for an unknown id would confirm which ids are real.
    const attempt = await page.request.post('/api/auth/sessions', {
      data: { id: theirId },
    });
    expect(attempt.status()).toBe(200);

    // The stranger's session still works, which is the actual assertion.
    expect((await request.get('/api/auth/activity')).status()).toBe(200);
  });

  test('needs a session of its own', async ({ request }) => {
    expect((await request.get('/api/auth/sessions')).status()).toBe(401);
    expect((await request.post('/api/auth/sessions', { data: { id: 'x' } })).status()).toBe(401);
  });

  test('rejects a malformed body', async ({ page }) => {
    await openVault(page, 'sessions-malformed');

    expect((await page.request.post('/api/auth/sessions', { data: {} })).status()).toBe(400);
    expect((await page.request.post('/api/auth/sessions', { data: { id: 42 } })).status()).toBe(
      400,
    );
  });

  test('an ended session is recorded in the activity list', async ({ page, browser }) => {
    const email = await openVault(page, 'sessions-audited');

    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await unlockVault(otherPage, email, PASSWORD);

    await openActivity(page);
    await page.getByTestId('revoke-session').first().click();
    await expect(page.getByTestId('session-row')).toHaveCount(1, { timeout: 30_000 });

    await page.getByTestId('activity-back').click();
    await openActivity(page);
    await expect(page.getByTestId('activity-list')).toContainText('session revoked');

    await other.close();
  });

  test('keeps five and drops the oldest', async ({ page, request }) => {
    /*
     * An account with forty live sessions is not somebody with forty devices.
     * It is somebody who signs in on public machines and never signs out, or
     * somebody whose password is in more than one pair of hands.
     *
     * The oldest goes, not the newest: refusing the new sign-in would lock out
     * the person actually standing at a keyboard.
     */
    const account = await buildAccount(uniqueEmail('sessions-limit'), PASSWORD);
    expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);

    // Seven sign-ins, each with its own cookie jar, so each is a real session.
    const jars = [];
    for (let n = 0; n < 7; n += 1) {
      const jar = await page.context().browser()?.newContext();
      if (!jar) throw new Error('no browser');
      const signIn = await jar.request.post('/api/auth/login', {
        data: { email: account.payload.email, authKey: account.payload.authKey },
      });
      expect(signIn.status()).toBe(200);
      jars.push(jar);
    }

    const last = jars[jars.length - 1];
    const listed = await last!.request.get('/api/auth/sessions');
    const body = (await listed.json()) as { sessions: unknown[] };

    expect(body.sessions).toHaveLength(5);

    // And the first two are actually finished, not merely off the list.
    expect((await jars[0]!.request.get('/api/auth/sessions')).status()).toBe(401);
    expect((await jars[1]!.request.get('/api/auth/sessions')).status()).toBe(401);

    for (const jar of jars) await jar.close();
  });
});
