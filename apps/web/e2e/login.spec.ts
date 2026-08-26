import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptString,
  deriveKeys,
  encryptString,
  unwrapAccountKeys,
} from '@core/crypto';
import type { KdfParams } from '@core/shared';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { FAST_KDF, buildAccount, loginWith, register, uniqueEmail } from './helpers/account';

/**
 * /api/auth/login and the session endpoints.
 *
 * The one that matters most is the round trip at the bottom: it signs up, logs
 * in, and then actually decrypts something with keys recovered from the login
 * response. That is the only way to show the wire format and the cryptography
 * agree end to end rather than merely appearing to.
 */

const login = loginWith;

/** Adapts the shared helper to the shape these tests already expect. */
async function registerAccount(request: APIRequestContext, label: string, password?: string) {
  const account = await register(request, label, password);
  return {
    email: account.payload.email,
    authKey: account.payload.authKey,
    kdfSalt: account.payload.kdfSalt,
    password: account.password,
  };
}

test.describe('login', () => {
  test('accepts the correct auth key and returns the wrapped keys', async ({ request }) => {
    const account = await registerAccount(request, 'ok');

    const response = await login(request, account.email, account.authKey);
    expect(response.status()).toBe(200);

    const body = (await response.json()) as Record<string, string>;
    expect(body.accountKeyWrapped).toMatch(/^v1\./);
    expect(body.privateKeyWrapped).toMatch(/^v1\./);
    expect(body.publicKey).toBeTruthy();
  });

  test('sets a hardened session cookie', async ({ request }) => {
    const account = await registerAccount(request, 'cookie');
    const response = await login(request, account.email, account.authKey);

    const setCookie = response.headers()['set-cookie'] ?? '';
    expect(setCookie).toContain('core_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');
  });

  test('rejects a wrong auth key', async ({ request }) => {
    const account = await registerAccount(request, 'wrongkey');
    const wrong = await registerAccount(request, 'other');

    const response = await login(request, account.email, wrong.authKey);
    expect(response.status()).toBe(401);
  });

  test('answers identically for a wrong password and an unknown address', async ({ request }) => {
    // If these differed in any way, login would become the enumeration oracle
    // that prelogin is carefully built to avoid being.
    const account = await registerAccount(request, 'sameerror');
    const other = await registerAccount(request, 'sameerror-other');

    const wrongPassword = await login(request, account.email, other.authKey);
    const unknownUser = await login(request, uniqueEmail('ghost'), account.authKey);

    expect(wrongPassword.status()).toBe(unknownUser.status());
    expect(await wrongPassword.text()).toBe(await unknownUser.text());
  });

  test('issues no cookie on a failed attempt', async ({ request }) => {
    const account = await registerAccount(request, 'nocookie');
    const other = await registerAccount(request, 'nocookie-other');

    const response = await login(request, account.email, other.authKey);
    expect(response.headers()['set-cookie'] ?? '').not.toContain('core_session=');
  });

  test('normalises the address', async ({ request }) => {
    const account = await registerAccount(request, 'casing');

    const response = await login(request, `  ${account.email.toUpperCase()} `, account.authKey);
    expect(response.status()).toBe(200);
  });

  test('rejects malformed bodies', async ({ request }) => {
    for (const data of [{}, { email: 'a@b.com' }, { authKey: 'x' }, { email: 'a@b.com', authKey: '!!' }]) {
      const response = await request.post('/api/auth/login', { data });
      expect(response.status()).toBe(400);
    }
  });

  test('never caches', async ({ request }) => {
    const account = await registerAccount(request, 'nocache');
    const response = await login(request, account.email, account.authKey);
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});

test.describe('session lifecycle', () => {
  test('reports a live session after login', async ({ request }) => {
    const account = await registerAccount(request, 'live');
    await login(request, account.email, account.authKey);

    const response = await request.get('/api/auth/session');
    expect(response.status()).toBe(200);
  });

  test('refuses without a session', async ({ playwright }) => {
    // A fresh context, so no cookie is carried over.
    const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    const response = await anonymous.get('/api/auth/session');
    expect(response.status()).toBe(401);
    await anonymous.dispose();
  });

  test('rejects a forged token', async ({ playwright }) => {
    const forged = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
      extraHTTPHeaders: { cookie: `core_session=${bytesToBase64Url(new Uint8Array(32).fill(1))}` },
    });
    const response = await forged.get('/api/auth/session');
    expect(response.status()).toBe(401);
    await forged.dispose();
  });

  test('logout revokes the session it was called with', async ({ request }) => {
    const account = await registerAccount(request, 'logout');
    await login(request, account.email, account.authKey);
    expect((await request.get('/api/auth/session')).status()).toBe(200);

    const loggedOut = await request.post('/api/auth/logout');
    expect(loggedOut.status()).toBe(200);
    expect(loggedOut.headers()['set-cookie'] ?? '').toContain('core_session=;');

    expect((await request.get('/api/auth/session')).status()).toBe(401);
  });

  test('logout is harmless without a session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    // 401 here would let a caller test whether a token is live.
    expect((await anonymous.post('/api/auth/logout')).status()).toBe(200);
    await anonymous.dispose();
  });
});

test.describe('end-to-end key recovery', () => {
  test('keys returned by login actually decrypt data encrypted before it', async ({ request }) => {
    // The test that matters. Everything else checks status codes; this checks
    // that the bytes crossing the wire are the bytes the crypto expects.
    const password = 'the real master password';
    const email = uniqueEmail('roundtrip');

    const built = await buildAccount(email, password);

    // Encrypted with the original Account Key, before any round trip.
    const secret = 'DATABASE_URL=postgres://user:pass@localhost/core';
    const envelope = await encryptString(built.keys.dataKey, secret);

    await request.post('/api/auth/signup', { data: built.payload });

    // Now start over as if on a new device: prelogin for the salt, derive, log in.
    const pre = await request.post('/api/auth/prelogin', { data: { email } });
    const { kdfSalt, kdfParams } = (await pre.json()) as { kdfSalt: string; kdfParams: KdfParams };

    const rederived = await deriveKeys(password, base64UrlToBytes(kdfSalt), kdfParams);
    const response = await login(request, email, bytesToBase64Url(rederived.authKey));
    expect(response.status()).toBe(200);

    const body = (await response.json()) as { accountKeyWrapped: string };
    const recovered = await unwrapAccountKeys(rederived.masterKey, body.accountKeyWrapped);

    expect(await decryptString(recovered.dataKey, envelope)).toBe(secret);
  });

  test('a wrong password cannot unwrap the account key even if login is bypassed', async ({
    request,
  }) => {
    // Defence in depth: even handed the wrapped key directly, the wrong master
    // password cannot open it. The server is not what keeps the vault shut.
    const account = await registerAccount(request, 'depth', 'correct password');
    const response = await login(request, account.email, account.authKey);
    const body = (await response.json()) as { accountKeyWrapped: string };

    const wrong = await deriveKeys(
      'wrong password',
      base64UrlToBytes(account.kdfSalt),
      FAST_KDF,
    );

    await expect(unwrapAccountKeys(wrong.masterKey, body.accountKeyWrapped)).rejects.toThrow();
  });
});
