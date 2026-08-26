import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';

/**
 * /api/auth/prelogin — the enumeration surface.
 *
 * This endpoint has to hand out a KDF salt to anyone who asks, before they have
 * proved anything. An attacker with a list of addresses will point it here
 * first, so the tests below are less about "does it work" and more about "can a
 * caller tell the difference between an address that exists and one that does
 * not".
 *
 * The seeded account comes from `pnpm db:seed`, run by the Playwright global
 * setup. Without it every lookup would miss and these tests would pass for the
 * wrong reason.
 */

const KNOWN = 'seed@core.test';
const UNKNOWN = 'definitely-not-registered@example.com';

interface PreloginBody {
  kdfSalt: string;
  kdfParams: { algorithm: string; memoryKiB: number; iterations: number; parallelism: number };
}

async function prelogin(request: APIRequestContext, email: string) {
  return request.post('/api/auth/prelogin', { data: { email } });
}

async function preloginBody(request: APIRequestContext, email: string): Promise<PreloginBody> {
  const response = await prelogin(request, email);
  expect(response.status()).toBe(200);
  return (await response.json()) as PreloginBody;
}

test.describe('prelogin behaviour', () => {
  test('returns a salt and parameters for a known account', async ({ request }) => {
    const body = await preloginBody(request, KNOWN);

    expect(body.kdfSalt).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.kdfParams.algorithm).toBe('argon2id');
    expect(body.kdfParams.iterations).toBeGreaterThan(0);
  });

  test('returns the same shape for an address that does not exist', async ({ request }) => {
    const known = await preloginBody(request, KNOWN);
    const unknown = await preloginBody(request, UNKNOWN);

    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect(Object.keys(unknown.kdfParams).sort()).toEqual(Object.keys(known.kdfParams).sort());
    expect(unknown.kdfSalt).toHaveLength(known.kdfSalt.length);
  });

  test('gives an unknown address the same answer every time', async ({ request }) => {
    // A random decoy would make enumeration trivial: ask twice and a changing
    // salt means no such account.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => preloginBody(request, UNKNOWN)),
    );
    const salts = new Set(responses.map((body) => body.kdfSalt));
    const iterations = new Set(responses.map((body) => body.kdfParams.iterations));

    expect(salts.size).toBe(1);
    expect(iterations.size).toBe(1);
  });

  test('does not fall back to default parameters for unknown addresses', async ({ request }) => {
    // Real accounts carry parameters calibrated on the device that created
    // them, so a constant default would mark a response as a decoy just as
    // clearly as a changing salt would.
    const bodies = await Promise.all(
      Array.from({ length: 12 }, (_, i) => preloginBody(request, `nobody-${i}@example.com`)),
    );
    const iterations = new Set(bodies.map((body) => body.kdfParams.iterations));

    expect(iterations.size).toBeGreaterThan(1);
  });

  test('normalises the address, so casing cannot be used to probe', async ({ request }) => {
    const lower = await preloginBody(request, KNOWN);
    const messy = await preloginBody(request, `  ${KNOWN.toUpperCase()} `);

    expect(messy.kdfSalt).toBe(lower.kdfSalt);
  });

  test('gives different unknown addresses different salts', async ({ request }) => {
    const a = await preloginBody(request, 'a@example.com');
    const b = await preloginBody(request, 'b@example.com');

    expect(a.kdfSalt).not.toBe(b.kdfSalt);
  });

  test('rejects a malformed body without touching the database', async ({ request }) => {
    for (const data of [{}, { email: '' }, { email: 12 }, { nope: 1 }]) {
      const response = await request.post('/api/auth/prelogin', { data });
      expect(response.status()).toBe(400);
    }
  });

  test('never caches, so a proxy cannot serve one account another answer', async ({ request }) => {
    const response = await prelogin(request, KNOWN);
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});

test.describe('prelogin timing', () => {
  // Each sample is padded to the constant-time budget, so this is inherently
  // slow. It is worth the wall-clock: timing is the leak that careful error
  // messages cannot close.
  test.slow();

  test('answers in the same time whether or not the account exists', async ({ request }) => {
    const SAMPLES = 40;

    const measure = async (email: string): Promise<number[]> => {
      const timings: number[] = [];
      for (let i = 0; i < SAMPLES; i += 1) {
        const started = Date.now();
        await prelogin(request, email);
        timings.push(Date.now() - started);
      }
      return timings;
    };

    // Warm up first: the first request through a cold route compiles it, and
    // that one-off cost would otherwise land entirely on whichever address is
    // measured first and look like a leak.
    await measure(KNOWN);

    const known = await measure(KNOWN);
    const unknown = await measure(UNKNOWN);

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] as number;
    };

    const knownMedian = median(known);
    const unknownMedian = median(unknown);
    const difference = Math.abs(knownMedian - unknownMedian);

    // The stated exit criterion for this phase.
    //
    // Read this result carefully. Against `next dev` the D1 binding is reached
    // through an IPC proxy costing ~130ms, which is over the constant-time
    // budget — so here the two paths match because the dev overhead is
    // symmetric, not because the padding hid anything. The padding itself is
    // covered by the unit tests in lib/server/timing.test.ts.
    //
    // This assertion only becomes a real proof of the property when it runs
    // against a Workers build, where the binding is local and the padding is
    // doing the work. Tracked as an open item until then.
    expect(
      difference,
      `known median ${knownMedian}ms vs unknown median ${unknownMedian}ms`,
    ).toBeLessThan(5);
  });
});
