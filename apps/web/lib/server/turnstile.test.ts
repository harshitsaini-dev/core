import { afterEach, describe, expect, it, vi } from 'vitest';
import { TURNSTILE_HEADER, turnstileEnabled, verifyTurnstile } from './turnstile';

/**
 * Turnstile.
 *
 * Two decisions are worth holding in tests, and neither is "does it verify".
 *
 * An instance with no secret key must not be a broken instance. Bot protection
 * is not a requirement for running your own copy, and refusing every request
 * because a self-hoster did not sign up for Cloudflare's service would make it
 * one.
 *
 * And a verification service that is unreachable must not stop sign-ins. This
 * runs in front of login. An instance that rejects logins because a third party
 * had a bad minute has done more damage than the bots it was holding off.
 */

const CONFIG = { secretKey: 'test-secret' };

function request(headers: Record<string, string> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new Request('https://example.test/api/auth/login', { headers }) as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('turnstileEnabled', () => {
  it('is off without a secret key', () => {
    expect(turnstileEnabled({ secretKey: undefined })).toBe(false);
    expect(turnstileEnabled({ secretKey: '' })).toBe(false);
  });
});

describe('verifyTurnstile', () => {
  it('allows everything, and calls nobody, when it is not configured', async () => {
    // Not "allows" alone — an unconfigured instance must make no outbound
    // request either, or every self-hoster without Turnstile is quietly
    // calling Cloudflare on their users' sign-in path.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyTurnstile({ secretKey: undefined }, request())).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a request with no token when it is configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyTurnstile(CONFIG, request())).toBe(false);
    // Refused locally: there is nothing to ask about.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a token Cloudflare accepts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 })),
    );

    expect(await verifyTurnstile(CONFIG, request({ [TURNSTILE_HEADER]: 'token' }))).toBe(true);
  });

  it('refuses a token Cloudflare rejects', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }),
          {
            status: 200,
          },
        ),
      ),
    );

    expect(await verifyTurnstile(CONFIG, request({ [TURNSTILE_HEADER]: 'token' }))).toBe(false);
  });

  it('sends the caller address so a token cannot be replayed elsewhere', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyTurnstile(
      CONFIG,
      request({ [TURNSTILE_HEADER]: 'token', 'cf-connecting-ip': '203.0.113.7' }),
    );

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('omits the address rather than guessing one', async () => {
    // A wrong address fails a token that was fine, which locally would mean
    // every sign-in refused.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await verifyTurnstile(CONFIG, request({ [TURNSTILE_HEADER]: 'token' }));

    const body = (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as FormData;
    expect(body.get('remoteip')).toBeNull();
  });

  it('fails open when the service is unreachable', async () => {
    // The one that matters. This sits in front of login.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));

    expect(await verifyTurnstile(CONFIG, request({ [TURNSTILE_HEADER]: 'token' }))).toBe(true);
  });

  it('fails open when the service answers with an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    expect(await verifyTurnstile(CONFIG, request({ [TURNSTILE_HEADER]: 'token' }))).toBe(true);
  });
});
