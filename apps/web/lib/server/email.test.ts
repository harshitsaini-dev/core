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

    // Both, so a client that shows text gets the version written for it.
    expect(body.html).toContain('core_');
  });

  it('never turns a link into a button', async () => {
    /*
     * The one rule the HTML has. A styled call-to-action in a mail from a
     * password manager teaches the habit that gets people phished — click the
     * nice button in the message saying something is wrong with your account —
     * and this product should not be the one teaching it.
     *
     * So a URL appears as itself, and the words around it are never the link.
     */
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const url = 'https://core.example.com/unlock?token=abc123';
    await send(CONFIG, {
      ...EMAIL,
      text: `Use this link:

${url}

It expires.`,
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      html: string;
    };

    // The address is the link text, so somebody can read where it goes.
    expect(body.html).toContain(`>${url}</a>`);

    // And nothing is dressed up as a button.
    expect(body.html).not.toMatch(/border-radius|padding:\s*1[2-9]px\s+3[0-9]px/i);
    expect(body.html.toLowerCase()).not.toContain('click here');
  });

  it('loads nothing from anywhere', async () => {
    // No image, no font, no tracking pixel: nothing to be blocked, and reading
    // the mail tells this server nothing about when or whether it was read.
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await send(CONFIG, EMAIL);

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      html: string;
    };

    expect(body.html).not.toContain('<img');
    expect(body.html).not.toContain('@import');
    expect(body.html).not.toContain('<script');
  });

  it('escapes what it renders', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await send(CONFIG, { ...EMAIL, text: '<script>alert(1)</script>' });

    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as {
      html: string;
    };

    expect(body.html).toContain('&lt;script&gt;');
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
