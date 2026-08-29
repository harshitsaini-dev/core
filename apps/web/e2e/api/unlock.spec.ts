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

/** Matches `LOCKOUT_THRESHOLD`, which is the login bucket's capacity. */
const LOCKOUT_ATTEMPTS = 5;

/**
 * A well-formed auth key that is simply wrong.
 *
 * Thirty-two zero bytes. The earlier value here was a sentence, which passed
 * the schema's base64url *alphabet* check and then failed to decode — and an
 * undecodable key used to reach the route as an exception and come back as a
 * 500 rather than a refusal.
 */
const WRONG_KEY = 'A'.repeat(43);

async function makeAccount(request: APIRequestContext) {
  const account = await buildAccount(uniqueEmail('unlock'), PASSWORD);
  expect((await request.post('/api/auth/signup', { data: account.payload })).status()).toBe(200);
  return account;
}

/**
 * Enough wrong passwords to lock an account.
 *
 * A different caller each time, which is not a trick — it is the shape of the
 * attack the lockout exists for. The rate limiter refuses one caller after five
 * attempts a minute and a refusal never reaches the counter, so an attacker
 * spread across addresses is precisely who can drive an account to its
 * threshold. Somebody mistyping from one machine meets the limiter instead.
 *
 * The first version of this used one caller for all of them, so every attempt
 * past the fifth came back 429 and the account was never locked at all. The
 * tests below still passed, because they only compared two responses to each
 * other.
 */
async function lockOut(request: APIRequestContext, email: string): Promise<void> {
  for (let attempt = 0; attempt < LOCKOUT_ATTEMPTS; attempt += 1) {
    const response = await request.post('/api/auth/login', {
      data: { email, authKey: WRONG_KEY },
      headers: { 'x-core-caller': `unlock-${email}-${attempt}` },
    });

    // Anything but a refused password means the account never got there.
    expect(response.status(), `attempt ${attempt + 1} was not counted`).toBe(401);
  }
}

test.describe('the lockout itself', () => {
  test.slow();

  test('a run of failures actually locks the account', async ({ request }) => {
    /*
     * The test that was missing, and its absence hid the bug it now covers.
     *
     * The threshold was ten while the login limiter allowed five a minute, and
     * a rate-limited request never reaches the counter — so a single caller
     * could never drive an account to its threshold and the lockout almost
     * never fired. Everything built on top of it, the alert and the emailed
     * link, was unreachable in the same way.
     *
     * Asserted by trying the *correct* password afterwards. Nothing else
     * distinguishes a locked account from the outside, which is deliberate:
     * login answers the same for a wrong password, an unknown address and a
     * locked account.
     */
    const account = await makeAccount(request);
    await lockOut(request, account.payload.email);

    const correct = await request.post('/api/auth/login', {
      data: { email: account.payload.email, authKey: account.payload.authKey },
      headers: { 'x-core-caller': `locked-${account.payload.email}` },
    });

    expect(correct.status(), 'the right password was accepted on a locked account').toBe(401);
  });

  test('an account that has not failed anything still opens', async ({ request }) => {
    // The other half: the lockout must not be something a fresh account is
    // already in.
    const account = await makeAccount(request);

    const correct = await request.post('/api/auth/login', {
      data: { email: account.payload.email, authKey: account.payload.authKey },
      headers: { 'x-core-caller': `fresh-${account.payload.email}` },
    });

    expect(correct.status()).toBe(200);
  });
});

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

test.describe('what a caller is told', () => {
  test.slow();

  test('a rate limit is not reported as a wrong password', async ({ request }) => {
    /*
     * These are different facts and the client used to conflate them: every
     * non-ok answer became "those credentials did not work", including a 429.
     * Somebody who had been refused for asking too often was told the one
     * thing that was definitely not true about their password.
     *
     * Saying so leaks nothing. A 429 describes this caller's request rate, and
     * an address that was never registered gets exactly the same one.
     */
    const email = uniqueEmail('rate-limited');

    let sawRateLimit = false;
    for (let attempt = 0; attempt < 12 && !sawRateLimit; attempt += 1) {
      const response = await request.post('/api/auth/login', {
        data: { email, authKey: WRONG_KEY },
        // One caller for all of them, which is what exhausts a bucket.
        headers: { 'x-core-caller': `burst-${email}` },
      });

      if (response.status() === 429) {
        sawRateLimit = true;
        expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
      }
    }

    expect(sawRateLimit, 'the limiter never refused a burst from one caller').toBe(true);
  });
});
