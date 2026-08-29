import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildAccount, uniqueEmail } from '../helpers/account';

/**
 * The link that lifts a lockout.
 *
 * The feature is small; what has to hold around it is not. A token that arrives
 * by email must lift a lock and do nothing else — no session, no cookie,
 * nothing that reaches a vault — because otherwise a mailbox becomes equivalent
 * to the vault and every claim this product makes turns into a claim about
 * somebody's email provider.
 *
 * The request endpoint has the other property worth testing: it answers
 * identically for an address that exists, one that does not, and one that is
 * not locked. Anything else is the account-existence oracle that prelogin,
 * signup and login are all built to withhold.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function makeAccount(request: APIRequestContext) {
  const account = await buildAccount(uniqueEmail('unlock'), PASSWORD);
  expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);
  return account;
}

/** Ten wrong passwords, which is what locks an account. */
async function lockOut(request: APIRequestContext, email: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await request.post('/api/auth/login', {
      data: { email, authKey: 'not-the-right-auth-key-at-all' },
      headers: { 'x-core-caller': `unlock-${email}` },
    });
  }
}

test.describe('unlock requests', () => {
  test.slow();

  test('answers the same for an address that does not exist', async ({ request }) => {
    // Identical answers, or this endpoint becomes the way to enumerate accounts
    // that every other endpoint refuses to be.
    const real = await makeAccount(request);
    await lockOut(request, real.payload.email);

    const known = await request.post('/api/auth/unlock-request', {
      data: { email: real.payload.email },
    });
    const unknown = await request.post('/api/auth/unlock-request', {
      data: { email: uniqueEmail('nobody') },
    });

    expect(known.status()).toBe(unknown.status());
    expect(await known.text()).toBe(await unknown.text());
  });

  test('answers the same for an account that is not locked', async ({ request }) => {
    const account = await makeAccount(request);

    const notLocked = await request.post('/api/auth/unlock-request', {
      data: { email: account.payload.email },
    });
    const unknown = await request.post('/api/auth/unlock-request', {
      data: { email: uniqueEmail('nobody') },
    });

    expect(notLocked.status()).toBe(unknown.status());
    expect(await notLocked.text()).toBe(await unknown.text());
  });

  test('is reachable without a bot-check token', async ({ request }) => {
    /*
     * The offer sits next to a failed sign-in, and by then the widget's token
     * is spent — it is single-use and the sign-in just used it. A Turnstile
     * check here refused every request with a 400 the button never looked at,
     * so the email simply never came. That is what this asserts against.
     */
    const response = await request.post('/api/auth/unlock-request', {
      data: { email: uniqueEmail('no-token') },
    });

    expect(response.status()).toBe(200);
  });

  test('rejects a malformed address', async ({ request }) => {
    expect((await request.post('/api/auth/unlock-request', { data: {} })).status()).toBe(400);
    expect(
      (await request.post('/api/auth/unlock-request', { data: { email: 'nope' } })).status(),
    ).toBe(400);
  });
});

test.describe('redeeming an unlock token', () => {
  test.slow();

  test('answers the same for a token that was never issued', async ({ request }) => {
    // No distinguishable rejection, so a stranger cannot test tokens.
    const invented = await request.post('/api/auth/unlock', { data: { token: 'invented-token' } });
    expect(invented.status()).toBe(200);
  });

  test('issues no session, and sets no cookie', async ({ request }) => {
    /*
     * The assertion the whole feature rests on. If this ever returned something
     * that reached a vault, an email account would be a vault key.
     *
     * Checked on the invalid path as well as it can be from here: no token is
     * obtainable in a test — it only exists inside an email — so what is
     * asserted is that this endpoint never sets a session cookie under any
     * input, which is the property that would have to break first.
     */
    const response = await request.post('/api/auth/unlock', { data: { token: 'anything' } });

    const setCookie = response.headers()['set-cookie'] ?? '';
    expect(setCookie).not.toContain('core_session');

    const body = (await response.json()) as Record<string, unknown>;
    expect(body['accountKeyWrapped']).toBeUndefined();
    expect(body['privateKeyWrapped']).toBeUndefined();
  });

  test('rejects a malformed body', async ({ request }) => {
    expect((await request.post('/api/auth/unlock', { data: {} })).status()).toBe(400);
    expect((await request.post('/api/auth/unlock', { data: { token: 42 } })).status()).toBe(400);
  });
});
