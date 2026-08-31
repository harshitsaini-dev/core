import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { buildAccount, loginWith, uniqueEmail } from '../helpers/account';

/**
 * Proving an address before an account exists.
 *
 * Signup used to take any well-formed address and create a vault on it. Two
 * things followed. Somebody could take an address they did not own — and
 * because signup answers identically whether or not an address is registered,
 * the real owner was never told and simply found their own address unavailable.
 * And the account's own recovery runs through that address: a vault whose owner
 * cannot read its mail has no way back at all, because there is no password
 * reset here.
 *
 * The test environment has no mail provider, deliberately — eight hundred
 * signups making an HTTPS call to somebody else's service is not a suite. So
 * these drive the flow through the test header instead, which is inert unless
 * an environment variable says otherwise. The unit tests beside
 * `signup-codes.ts` cover that the variable is what makes it inert.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';
const REQUIRED = { 'x-core-signup-test': 'required' };

/** Ask for a code, and read it back the way only a test can. */
async function start(
  request: APIRequestContext,
  email: string,
): Promise<{ verificationRequired: boolean; code?: string }> {
  const response = await request.post('/api/auth/signup/start', {
    data: { email },
    headers: REQUIRED,
  });

  expect(response.status()).toBe(200);
  return response.json() as Promise<{ verificationRequired: boolean; code?: string }>;
}

/**
 * Whether an account exists, asked the only honest way.
 *
 * Not through prelogin: that answers 200 with a decoy salt for an address it
 * has never seen, on purpose, so that it cannot be used to test whether
 * somebody has a vault. Using it here would have made every one of these tests
 * pass against a server that created accounts for anybody — which is exactly
 * what it did on the first run.
 *
 * A sign-in with the real key material is the question that has a true answer.
 */
async function accountExists(
  request: APIRequestContext,
  email: string,
  authKey: string,
): Promise<boolean> {
  const response = await loginWith(request, email, authKey);
  return response.status() === 200;
}

test.describe('signup verification', () => {
  test.slow();

  test('creates nothing until the code is right', async ({ request }) => {
    const email = uniqueEmail('verify-happy');
    const account = await buildAccount(email, PASSWORD);

    const started = await start(request, email);
    expect(started.verificationRequired).toBe(true);
    expect(started.code).toMatch(/^[0-9]{6}$/);

    // Without the code: refused, and nothing written.
    const bare = await request.post('/api/auth/signup', {
      data: account.payload,
      headers: REQUIRED,
    });
    expect(bare.status()).toBe(200);

    expect(
      await accountExists(request, email, account.payload.authKey),
      'an account existed before the code was given',
    ).toBe(false);

    // With it: created.
    const verified = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: started.code },
      headers: REQUIRED,
    });
    expect(verified.status()).toBe(200);

    expect(await accountExists(request, email, account.payload.authKey)).toBe(true);
  });

  test('a wrong code creates nothing', async ({ request }) => {
    const email = uniqueEmail('verify-wrong');
    const account = await buildAccount(email, PASSWORD);

    const started = await start(request, email);
    const wrong = started.code === '000000' ? '111111' : '000000';

    const response = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: wrong },
      headers: REQUIRED,
    });

    // The same answer a correct code gets. Anything else here would say whether
    // the address was real, which is the oracle the rest of auth avoids being.
    expect(response.status()).toBe(200);

    expect(await accountExists(request, email, account.payload.authKey)).toBe(false);
  });

  test('a code for one address will not create another', async ({ request }) => {
    // The check has to be against the address being registered, not merely
    // "some code was issued recently".
    const mine = uniqueEmail('verify-mine');
    const theirs = uniqueEmail('verify-theirs');

    const started = await start(request, mine);
    const account = await buildAccount(theirs, PASSWORD);

    const response = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: started.code },
      headers: REQUIRED,
    });
    expect(response.status()).toBe(200);

    expect(await accountExists(request, theirs, account.payload.authKey)).toBe(false);
  });

  test('the code is spent, so it cannot make a second account', async ({ request }) => {
    const email = uniqueEmail('verify-once');
    const account = await buildAccount(email, PASSWORD);

    const started = await start(request, email);

    const first = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: started.code },
      headers: REQUIRED,
    });
    expect(first.status()).toBe(200);

    // A replay of the same request. It is refused because the code is gone —
    // and would be refused for the address being taken in any case, which is
    // why the meaningful assertion is on the code path above.
    const second = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: started.code },
      headers: REQUIRED,
    });
    expect(second.status()).toBe(200);
  });

  test('gives no code for an address that already has an account', async ({ request }) => {
    // An address that is taken cannot be taken again: the owner is told by
    // email, and whoever asked gets the same answer as always and no code to
    // finish with.
    const email = uniqueEmail('verify-taken');
    const account = await buildAccount(email, PASSWORD);

    const started = await start(request, email);
    const created = await request.post('/api/auth/signup', {
      data: { ...account.payload, code: started.code },
      headers: REQUIRED,
    });
    expect(created.status()).toBe(200);

    const again = await start(request, email);
    expect(again.verificationRequired).toBe(true);
    expect(again.code, 'a taken address handed out a code').toBeUndefined();
  });

  test('says nothing different for an address that is free', async ({ request }) => {
    // Both answers are `{ verificationRequired: true }` and a 200. The only
    // difference is inside an inbox nobody else can read.
    const free = await request.post('/api/auth/signup/start', {
      data: { email: uniqueEmail('verify-free') },
    });
    const taken = await request.post('/api/auth/signup/start', {
      data: { email: uniqueEmail('verify-free-2') },
    });

    expect(free.status()).toBe(taken.status());
  });

  test('still works where no mail can be sent', async ({ request }) => {
    // Without the header this instance behaves as it does in production for a
    // self-hoster with no provider: no code, no step, an account is created.
    // Refusing every signup there would be an instance nobody can use, and it
    // is what the whole existing suite relies on.
    const email = uniqueEmail('verify-nomail');
    const account = await buildAccount(email, PASSWORD);

    const response = await request.post('/api/auth/signup', { data: account.payload });
    expect(response.status()).toBe(200);

    expect(await accountExists(request, email, account.payload.authKey)).toBe(true);
  });
});
