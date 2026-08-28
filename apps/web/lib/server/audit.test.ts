import { describe, expect, it, vi } from 'vitest';
import { record } from './audit';

/**
 * Writing to the audit log.
 *
 * One property, and it is the whole file: recording an event must never be able
 * to change the outcome of the request being recorded.
 *
 * This is unit-tested rather than driven through a route because the failure it
 * guards against needs the database write to throw, and there is no honest way
 * to make a real D1 write fail on demand from a browser test. What can be
 * tested is the mechanism every route now goes through — so that is what these
 * do, and the routes are checked by reading them rather than by pretending an
 * end-to-end test covers it.
 */

const pepper = new Uint8Array(32) as Uint8Array<ArrayBuffer>;

const request = new Request('https://example.test/api/auth/login', {
  headers: {
    'cf-connecting-ip': '203.0.113.9',
    'user-agent': 'test-agent',
    'cf-ipcountry': 'IN',
  },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

function db(values: (row: unknown) => Promise<unknown>) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { insert: () => ({ values }) } as any;
}

describe('record', () => {
  it('writes the event', async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    await record(db(values), pepper, request, 'user-1', 'login');

    expect(values).toHaveBeenCalledOnce();
    expect(values.mock.calls[0]?.[0]).toMatchObject({ userId: 'user-1', event: 'login' });
  });

  it('does not throw when the write fails', async () => {
    // The one that matters. As a bare insert on the login route, a rejection
    // here answered 500 for an address that exists and 401 for one that does
    // not — the enumeration oracle the rest of that path is built to close.
    const values = vi.fn().mockRejectedValue(new Error('D1 lost the write'));

    await expect(record(db(values), pepper, request, 'user-1', 'login')).resolves.toBeUndefined();
  });

  it('stores the address hashed, and never in the clear', async () => {
    // The user can still be shown "a sign-in from an unfamiliar country"
    // without the database becoming a log of everywhere they have been.
    const values = vi.fn().mockResolvedValue(undefined);
    await record(db(values), pepper, request, 'user-1', 'login');

    const row = values.mock.calls[0]?.[0] as { ipHash: string; uaHash: string; geoCountry: string };

    expect(row.ipHash).not.toContain('203.0.113.9');
    expect(row.uaHash).not.toContain('test-agent');
    expect(row.geoCountry).toBe('IN');
  });

  it('records something even when the headers are absent', async () => {
    // Locally, and behind anything that is not Cloudflare, none of these
    // arrive. An entry with no address is still worth having.
    const values = vi.fn().mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bare = new Request('https://example.test/x') as any;

    await record(db(values), pepper, bare, 'user-1', 'logout');

    const row = values.mock.calls[0]?.[0] as { geoCountry: string | null };
    expect(values).toHaveBeenCalledOnce();
    expect(row.geoCountry).toBeNull();
  });
});
