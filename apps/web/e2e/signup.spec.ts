import type { KdfParams } from '@core/shared';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { FAST_KDF, buildAccount, uniqueEmail } from './helpers/account';
import type { SignupPayload } from './helpers/account';

/**
 * /api/auth/signup
 *
 * These build the request the way a real client would, via the shared helper
 * that uses the same `@core/crypto` the browser does. Hand-written fixtures
 * would let the tests drift from the client and stop proving the two agree on
 * the wire format.
 */

async function buildSignup(email: string, password: string): Promise<SignupPayload> {
  return (await buildAccount(email, password)).payload;
}

async function signup(request: APIRequestContext, payload: Partial<SignupPayload>) {
  return request.post('/api/auth/signup', { data: payload });
}

test.describe('signup', () => {
  test('creates an account from client-derived key material', async ({ request }) => {
    const payload = await buildSignup(uniqueEmail('new'), 'a strong master password');

    const response = await signup(request, payload);
    expect(response.status()).toBe(200);
  });

  test('the account is immediately usable by prelogin', async ({ request }) => {
    const email = uniqueEmail('prelogin');
    const payload = await buildSignup(email, 'another master password');
    await signup(request, payload);

    const response = await request.post('/api/auth/prelogin', { data: { email } });
    const body = (await response.json()) as { kdfSalt: string; kdfParams: KdfParams };

    // The salt now comes from the stored row rather than the decoy path.
    expect(body.kdfSalt).toBe(payload.kdfSalt);
    expect(body.kdfParams.iterations).toBe(FAST_KDF.iterations);
    expect(body.kdfParams.memoryKiB).toBe(FAST_KDF.memoryKiB);
  });

  test('does not reveal that an address is already registered', async ({ request }) => {
    // Reporting "already taken" would undo everything prelogin does to avoid
    // being an enumeration oracle.
    const email = uniqueEmail('duplicate');

    const first = await signup(request, await buildSignup(email, 'first password'));
    const second = await signup(request, await buildSignup(email, 'second password'));

    expect(first.status()).toBe(second.status());
    expect(await first.text()).toBe(await second.text());
  });

  test('a duplicate signup does not overwrite the original account', async ({ request }) => {
    const email = uniqueEmail('nooverwrite');
    const original = await buildSignup(email, 'original password');
    await signup(request, original);

    // An attacker who could re-register an address would destroy the vault.
    await signup(request, await buildSignup(email, 'attacker password'));

    const response = await request.post('/api/auth/prelogin', { data: { email } });
    const body = (await response.json()) as { kdfSalt: string };
    expect(body.kdfSalt).toBe(original.kdfSalt);
  });

  test('normalises the address, so casing cannot create a second account', async ({ request }) => {
    const email = uniqueEmail('casing');
    const original = await buildSignup(email, 'password one');
    await signup(request, original);

    await signup(request, await buildSignup(email.toUpperCase(), 'password two'));

    const response = await request.post('/api/auth/prelogin', { data: { email } });
    const body = (await response.json()) as { kdfSalt: string };
    expect(body.kdfSalt).toBe(original.kdfSalt);
  });

  test('rejects a body that is missing key material', async ({ request }) => {
    const complete = await buildSignup(uniqueEmail('partial'), 'password');

    for (const omitted of [
      'authKey',
      'kdfSalt',
      'accountKeyWrapped',
      'publicKey',
      'privateKeyWrapped',
      'recoveryVerifier',
    ] as const) {
      const partial: Partial<SignupPayload> = { ...complete };
      delete partial[omitted];

      const response = await signup(request, partial);
      expect(response.status(), `omitting ${omitted} must be rejected`).toBe(400);
    }
  });

  test('rejects anything that is not a v1 ciphertext envelope', async ({ request }) => {
    const base = await buildSignup(uniqueEmail('envelope'), 'password');

    for (const bad of ['plaintext', 'v2.aaa.bbb', 'v1.only-two', '']) {
      const response = await signup(request, { ...base, accountKeyWrapped: bad });
      expect(response.status(), `accepted ${JSON.stringify(bad)}`).toBe(400);
    }
  });

  test('rejects KDF parameters weak enough to be an attack', async ({ request }) => {
    // A client that talks the server into storing 1 KiB of memory cost has
    // downgraded that account's offline resistance permanently.
    const base = await buildSignup(uniqueEmail('weakkdf'), 'password');

    for (const kdfParams of [
      { ...FAST_KDF, memoryKiB: 8 },
      { ...FAST_KDF, iterations: 0 },
      { ...FAST_KDF, algorithm: 'md5' },
    ]) {
      const response = await signup(request, { ...base, kdfParams } as Partial<SignupPayload>);
      expect(response.status(), `accepted ${JSON.stringify(kdfParams)}`).toBe(400);
    }
  });

  test('rejects a malformed address', async ({ request }) => {
    const base = await buildSignup(uniqueEmail('bademail'), 'password');

    for (const email of ['not-an-email', '@example.com', '']) {
      const response = await signup(request, { ...base, email });
      expect(response.status()).toBe(400);
    }
  });

  test('never caches the response', async ({ request }) => {
    const response = await signup(request, await buildSignup(uniqueEmail('cache'), 'password'));
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});
