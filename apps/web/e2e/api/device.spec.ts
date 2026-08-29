import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildAccount, uniqueEmail } from '../helpers/account';

/**
 * A sign-in from a browser this account has not used before.
 *
 * The moment worth pausing on is not a sign-in — people buy laptops — but the
 * first one from somewhere new, which is also what a stolen password looks
 * like.
 *
 * One property matters more than the rest and every test here is arranged
 * around it: **the code does not open the vault.** It releases a session. The
 * master password was already required to get the code sent at all, and the
 * keys still only open in a browser that can derive the Master Key. If that
 * ever stopped being true, a mailbox would be a second way in, and this
 * product's whole claim is that there is no second way in.
 *
 * Email is off in this environment, so the check runs in its "cannot send"
 * mode — which is itself worth holding: an instance with no email must not be
 * one where nobody can sign in.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function makeAccount(request: APIRequestContext) {
  const account = await buildAccount(uniqueEmail('device'), PASSWORD);
  expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);
  return account;
}

test.describe('verifying a device', () => {
  test.slow();

  test('signing in still works where the instance cannot send email', async ({ request }) => {
    /*
     * The guard that keeps this feature from being a lockout.
     *
     * A self-hosted copy with no Resend key must not be one where every sign-in
     * waits for a code that will never arrive. With email off the check is
     * skipped entirely and the session is issued as before.
     */
    const account = await makeAccount(request);

    const response = await request.post('/api/auth/login', {
      data: { email: account.payload.email, authKey: account.payload.authKey },
      headers: { 'x-core-caller': `device-${account.payload.email}` },
    });

    expect(response.status()).toBe(200);

    const body = (await response.json()) as { status: string; accountKeyWrapped?: string };
    expect(body.status).toBe('ok');
    expect(body.accountKeyWrapped).toBeTruthy();
  });

  test('a code cannot be redeemed for an address that has none', async ({ request }) => {
    // Same refusal for an unknown address and a wrong code. A different answer
    // would say whether the address is real.
    const unknown = await request.post('/api/auth/verify-device', {
      data: { email: uniqueEmail('nobody'), code: '000000' },
    });

    const account = await makeAccount(request);
    const known = await request.post('/api/auth/verify-device', {
      data: { email: account.payload.email, code: '000000' },
    });

    expect(unknown.status()).toBe(known.status());
    expect(await unknown.text()).toBe(await known.text());
  });

  test('refuses anything that is not six digits', async ({ request }) => {
    const account = await makeAccount(request);

    for (const code of ['', '12345', '1234567', 'abcdef', '12 456']) {
      const response = await request.post('/api/auth/verify-device', {
        data: { email: account.payload.email, code },
      });
      expect(response.status(), `accepted ${JSON.stringify(code)}`).toBe(400);
    }
  });

  test('issues no session when the code is refused', async ({ request }) => {
    // The assertion the whole feature rests on. A wrong code must leave the
    // caller exactly where they were.
    const account = await makeAccount(request);

    const response = await request.post('/api/auth/verify-device', {
      data: { email: account.payload.email, code: '000000' },
    });

    const setCookie = response.headers()['set-cookie'] ?? '';
    expect(setCookie).not.toContain('core_session');
    expect(setCookie).not.toContain('core_device');
  });

  test('never returns keys to a caller who did not pass', async ({ request }) => {
    const account = await makeAccount(request);

    const response = await request.post('/api/auth/verify-device', {
      data: { email: account.payload.email, code: '111111' },
    });

    const body = (await response.text()).toLowerCase();
    expect(body).not.toContain('accountkeywrapped');
    expect(body).not.toContain('privatekeywrapped');
  });
});
