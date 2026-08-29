import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';
import { openPanel } from './helpers/vault-nav';

/**
 * Unlocking with a passkey.
 *
 * Driven by Chrome's virtual authenticator over CDP, because the alternative is
 * a test nobody can run without a fingerprint reader.
 *
 * What is being tested is narrower than "passkeys work". The claim this feature
 * rests on is that the key comes from the authenticator and never from the
 * server — so the assertions are that a vault opens with no password typed,
 * that nothing about the passkey leaves the browser, and that a device whose
 * authenticator cannot derive a key is not offered the feature at all.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

/**
 * A software authenticator that can do PRF.
 *
 * `hasPrf` is the whole reason this is testable: without it Chrome's virtual
 * authenticator signs but derives nothing, which is exactly the case the
 * product refuses to build on.
 */
async function addAuthenticator(page: Page, prf: boolean): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      ctap2Version: 'ctap2_1',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      hasPrf: prf,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  } as never);
  return cdp;
}

async function openQuickUnlock(page: Page): Promise<void> {
  await openPanel(page, 'open-pin');
  await expect(page.getByTestId('pin-setup')).toBeVisible();
}

test.describe('passkey unlock', () => {
  test.slow();
  test.skip(({ browserName }) => browserName !== 'chromium', 'needs a virtual authenticator');

  test('adds a passkey and opens the vault with it', async ({ page }) => {
    const cdp = await addAuthenticator(page, true);
    const email = await openVault(page, 'passkey-add');

    await openQuickUnlock(page);
    await page.getByTestId('passkey-email').fill(email);
    await page.getByTestId('passkey-password').fill(PASSWORD);
    await page.getByTestId('passkey-add').click();
    await expect(page.getByTestId('passkey-enabled')).toBeVisible({ timeout: 60_000 });

    await page.goto('/login');
    await page.getByTestId('passkey-unlock').click();

    // No password typed anywhere on this screen.
    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });
    await expect(page.getByTestId('vault-state')).toContainText('unlocked');

    await cdp.detach();
  });

  test('refuses an authenticator that cannot derive a key', async ({ page }) => {
    /*
     * The design decision, asserted. A passkey that signs but does not derive
     * could only be used by checking a signature in the page and then handing
     * over the vault key — an `if` statement in front of a secret. So the
     * feature is refused rather than faked.
     */
    const cdp = await addAuthenticator(page, false);
    const email = await openVault(page, 'passkey-no-prf');

    await openQuickUnlock(page);
    await page.getByTestId('passkey-email').fill(email);
    await page.getByTestId('passkey-password').fill(PASSWORD);
    await page.getByTestId('passkey-add').click();

    /*
     * The message is asserted, not just the refusal.
     *
     * Without PRF the flow fails twice over — once at the check after
     * registration, and again when the assertion returns no key material — so a
     * test that only looked for "an error" passed with the first check removed.
     * This one distinguishes them.
     */
    await expect(page.getByTestId('passkey-error')).toContainText('cannot derive a key', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('passkey-enabled')).toHaveCount(0);

    await cdp.detach();
  });

  test('will not add one on a wrong master password', async ({ page }) => {
    const cdp = await addAuthenticator(page, true);
    const email = await openVault(page, 'passkey-wrong-password');

    await openQuickUnlock(page);
    await page.getByTestId('passkey-email').fill(email);
    await page.getByTestId('passkey-password').fill('not-the-master-password');
    await page.getByTestId('passkey-add').click();

    await expect(page.getByTestId('passkey-error')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('passkey-enabled')).toHaveCount(0);

    await cdp.detach();
  });

  test('nothing about the passkey reaches the server', async ({ page }) => {
    // The claim the feature rests on. If any of this travelled, the server
    // would be a party to unlocking, which is the thing the design forbids.
    const bodies: string[] = [];
    const urls: string[] = [];
    page.on('request', (request) => {
      urls.push(request.url());
      const body = request.postData();
      if (body) bodies.push(body);
    });

    const cdp = await addAuthenticator(page, true);
    const email = await openVault(page, 'passkey-not-sent');

    await openQuickUnlock(page);
    await page.getByTestId('passkey-email').fill(email);
    await page.getByTestId('passkey-password').fill(PASSWORD);
    await page.getByTestId('passkey-add').click();
    await expect(page.getByTestId('passkey-enabled')).toBeVisible({ timeout: 60_000 });

    await page.goto('/login');
    await page.getByTestId('passkey-unlock').click();
    await expect(page).toHaveURL(/\/vault$/, { timeout: 60_000 });

    expect(urls.length, 'no requests were seen, so this proves nothing').toBeGreaterThan(0);
    expect(bodies.join('\n')).not.toContain(PASSWORD);
    expect(bodies.join('\n')).not.toContain('publicKey');
    expect(urls.join('\n')).not.toContain('passkey');

    await cdp.detach();
  });

  test('turning it off leaves the login screen without the button', async ({ page }) => {
    const cdp = await addAuthenticator(page, true);
    const email = await openVault(page, 'passkey-off');

    await openQuickUnlock(page);
    await page.getByTestId('passkey-email').fill(email);
    await page.getByTestId('passkey-password').fill(PASSWORD);
    await page.getByTestId('passkey-add').click();
    await expect(page.getByTestId('passkey-enabled')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('passkey-disable').click();
    await expect(page.getByTestId('passkey-add')).toBeVisible();

    await page.goto('/login');
    await expect(page.getByTestId('passkey-unlock')).toHaveCount(0);
    await expect(page.getByLabel('master password')).toBeVisible();

    await cdp.detach();
  });
});
