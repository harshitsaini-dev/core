import { expect, test } from '@playwright/test';
import type { APIRequestContext, PlaywrightWorkerArgs } from '@playwright/test';
import { buildAccount, loginWith, register, uniqueEmail } from '../helpers/account';

/**
 * Rate limiting and account lockout.
 *
 * Every test gets its own caller address, because the limiter buckets by
 * caller and tests that shared one would refuse each other rather than
 * whatever they meant to test.
 *
 * The address arrives in `x-core-caller`, which the server reads only when
 * `RATE_LIMIT_TEST_MODE` is set — in `.dev.vars` and the CI workflows, nowhere
 * else. Production takes the caller from `cf-connecting-ip` and never looks at
 * this header at all.
 *
 * That indirection exists for a reason worth knowing: locally, workerd sets
 * `cf-connecting-ip` itself, so the limiter is live and the whole suite shares
 * one address. Without a way to name themselves, these tests would throttle
 * every other test in the run.
 */

let counter = 0;

/**
 * The `playwright` fixture's own type.
 *
 * `@playwright/test` does not export it by name, and the fixture is the only
 * way to open a request context with headers of our choosing.
 */
type PlaywrightFixture = PlaywrightWorkerArgs['playwright'];

/** A caller nobody else in this file is using. */
function freshAddress(): string {
  counter += 1;
  return `caller-${counter}-${crypto.randomUUID()}`;
}

async function caller(
  playwright: PlaywrightFixture,
  address = freshAddress(),
): Promise<APIRequestContext> {
  return playwright.request.newContext({
    baseURL: 'http://localhost:3000',
    extraHTTPHeaders: { 'x-core-caller': address },
  });
}

async function preloginOnce(request: APIRequestContext, email: string) {
  return request.post('/api/auth/prelogin', { data: { email } });
}

test.describe('per-caller limits', () => {
  test.slow();

  test('refuses a burst of logins and says when to come back', async ({ playwright }) => {
    const request = await caller(playwright);
    const account = await buildAccount(uniqueEmail('rl-burst'));

    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      const response = await loginWith(request, account.payload.email, account.payload.authKey);
      statuses.push(response.status());
      if (response.status() === 429) {
        expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
        break;
      }
    }

    expect(statuses).toContain(429);
    await request.dispose();
  });

  test('a refusal says nothing about any account', async ({ playwright }) => {
    const request = await caller(playwright);
    const account = await buildAccount(uniqueEmail('rl-quiet'));

    let body = '';
    for (let i = 0; i < 8; i += 1) {
      const response = await loginWith(request, account.payload.email, account.payload.authKey);
      if (response.status() === 429) {
        body = await response.text();
        break;
      }
    }

    expect(body).not.toBe('');
    expect(body.toLowerCase()).not.toContain('user');
    expect(body.toLowerCase()).not.toContain('account');
    expect(body).not.toContain(account.payload.email);
  });

  test('one caller being throttled does not throttle another', async ({ playwright }) => {
    // The bucket is per caller. A shared one would let anybody lock everybody
    // out, which is a denial of service wearing a seatbelt.
    const noisy = await caller(playwright);
    const quiet = await caller(playwright);
    const account = await buildAccount(uniqueEmail('rl-neighbour'));

    for (let i = 0; i < 8; i += 1) {
      await loginWith(noisy, account.payload.email, account.payload.authKey);
    }

    const response = await loginWith(quiet, account.payload.email, account.payload.authKey);
    expect(response.status()).not.toBe(429);

    await noisy.dispose();
    await quiet.dispose();
  });

  test('is looser on prelogin than on login', async ({ playwright }) => {
    // Prelogin is not a guess: it is the lookup a legitimate client must make
    // before it can derive anything, and a flaky connection retries it.
    const request = await caller(playwright);
    const email = uniqueEmail('rl-prelogin');

    for (let i = 0; i < 8; i += 1) {
      const response = await preloginOnce(request, email);
      expect(response.status(), `prelogin ${i + 1} should still be allowed`).toBe(200);
    }

    await request.dispose();
  });

  test('eventually refuses prelogin too', async ({ playwright }) => {
    const request = await caller(playwright);
    const email = uniqueEmail('rl-prelogin-cap');

    let refused = false;
    for (let i = 0; i < 40; i += 1) {
      const response = await preloginOnce(request, email);
      if (response.status() === 429) {
        refused = true;
        break;
      }
    }

    expect(refused, 'prelogin never refused, so an enumeration sweep is unbounded').toBe(true);
    await request.dispose();
  });

  test('limits signup', async ({ playwright }) => {
    const request = await caller(playwright);

    let refused = false;
    for (let i = 0; i < 8; i += 1) {
      const account = await buildAccount(uniqueEmail(`rl-signup-${i}`));
      const response = await request.post('/api/auth/signup', { data: account.payload });
      if (response.status() === 429) {
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
    await request.dispose();
  });

  test('leaves an ordinary session alone', async ({ playwright }) => {
    // The limits exist to stop guessing, not to interrupt somebody using the
    // product. One signup and one login must never be refused.
    const request = await caller(playwright);
    const account = await register(request, 'rl-ordinary');

    const response = await loginWith(request, account.payload.email, account.payload.authKey);
    expect(response.status()).toBe(200);

    for (let i = 0; i < 10; i += 1) {
      const sync = await request.get('/api/vault/sync?since=0');
      expect(sync.status(), `sync ${i + 1} should be allowed`).toBe(200);
    }

    await request.dispose();
  });
});

test.describe('account lockout', () => {
  test.slow();

  /**
   * Ten failures against one account, spread across callers.
   *
   * Spread deliberately: the per-caller limit would stop a single address long
   * before ten, so a distributed attacker is the only one who reaches the
   * lockout — which is exactly the case the lockout exists for.
   */
  async function failTenTimes(playwright: PlaywrightFixture, email: string): Promise<void> {
    const wrong = await buildAccount(uniqueEmail('rl-wrong'));

    for (let i = 0; i < 10; i += 1) {
      const request = await caller(playwright);
      const response = await loginWith(request, email, wrong.payload.authKey);
      expect(response.status(), `attempt ${i + 1} should be a plain rejection`).toBe(401);
      await request.dispose();
    }
  }

  test('refuses the correct password once the account is locked', async ({ playwright }) => {
    const setup = await caller(playwright);
    const account = await register(setup, 'rl-lock');
    await setup.dispose();

    await failTenTimes(playwright, account.payload.email);

    const request = await caller(playwright);
    const response = await loginWith(request, account.payload.email, account.payload.authKey);

    expect(response.status()).toBe(401);
    await request.dispose();
  });

  test('a locked account is indistinguishable from a wrong password', async ({ playwright }) => {
    // Saying "this account is locked" would confirm the account exists, which
    // is the one thing every other decision on this path avoids.
    const setup = await caller(playwright);
    const account = await register(setup, 'rl-lock-quiet');
    await setup.dispose();

    await failTenTimes(playwright, account.payload.email);

    const lockedCaller = await caller(playwright);
    const locked = await loginWith(lockedCaller, account.payload.email, account.payload.authKey);
    const lockedBody = await locked.text();
    await lockedCaller.dispose();

    const unknownCaller = await caller(playwright);
    const unknown = await buildAccount(uniqueEmail('rl-nobody'));
    const missing = await loginWith(unknownCaller, unknown.payload.email, unknown.payload.authKey);
    const missingBody = await missing.text();
    await unknownCaller.dispose();

    expect(locked.status()).toBe(missing.status());
    expect(lockedBody).toBe(missingBody);
  });

  test('an account nobody has attacked still opens', async ({ playwright }) => {
    // The counterpart to the test above: the lockout must not be something a
    // normal account drifts into.
    const request = await caller(playwright);
    const account = await register(request, 'rl-unlocked');

    for (let i = 0; i < 3; i += 1) {
      const response = await loginWith(request, account.payload.email, account.payload.authKey);
      expect(response.status()).toBe(200);
    }

    await request.dispose();
  });
});
