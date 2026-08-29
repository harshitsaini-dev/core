import { afterEach, describe, expect, it, vi } from 'vitest';
import { emailEnabled, send } from './email';

/**
 * Sending email.
 *
 * Two properties, and the second is the one that matters on an auth path:
 * an instance with no key is a working instance with the notifications off,
 * and a send that fails never reaches the caller as an exception. A password
 * manager that returns 500 because a third party had a bad minute is worse
 * than one that quietly did not warn about something the owner already knew.
 */

const CONFIG = { apiKey: 'test-key', from: 'Core <no-reply@mail.example.com>' };
const EMAIL = { to: 'someone@example.com', subject: 'subject', text: 'body' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('emailEnabled', () => {
  it('is off without a key or a sender', () => {
    expect(emailEnabled({ apiKey: undefined, from: CONFIG.from })).toBe(false);
    expect(emailEnabled({ apiKey: CONFIG.apiKey, from: undefined })).toBe(false);
    expect(emailEnabled({ apiKey: '', from: '' })).toBe(false);
  });

  it('is on with both', () => {
    expect(emailEnabled(CONFIG)).toBe(true);
  });
});

describe('send', () => {
  it('sends nothing at all when the instance has no key', async () => {
    // Not "sends and fails" — an unconfigured instance must make no outbound
    // request, or every self-hoster without Resend is quietly calling a third
    // party on their users' auth path.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await send({ apiKey: undefined, from: undefined }, EMAIL)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts the message when configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await send(CONFIG, EMAIL)).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');

    const body = JSON.parse(String(init.body)) as { to: string[]; html?: string; text: string };
    expect(body.to).toEqual([EMAIL.to]);
    expect(body.text).toBe(EMAIL.text);

    // Text only, on purpose. An HTML mail from a password manager is a mail
    // with a styled button in it, which is the exact shape of the phishing it
    // would be teaching people to click.
    expect(body.html).toBeUndefined();
  });

  it('reports a refusal rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 422 })));

    await expect(send(CONFIG, EMAIL)).resolves.toBe(false);
  });

  it('reports a network failure rather than throwing', async () => {
    // The one that matters. This runs inside a login and a password change, and
    // neither should turn into a 500 because Resend was unreachable.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('unreachable')));

    await expect(send(CONFIG, EMAIL)).resolves.toBe(false);
  });

  it('never writes the address it was given to the log', async () => {
    // A log line naming who was emailed is a log of who has an account, which
    // is what every other decision on the auth path is arranged to withhold.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));

    await send(CONFIG, EMAIL);

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).not.toContain(EMAIL.to);

    warn.mockRestore();
  });
});
