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

    const once = async (email: string): Promise<number> => {
      const started = Date.now();
      await prelogin(request, email);
      return Date.now() - started;
    };

    // Warm up first: the first request through a cold route compiles it, and
    // that one-off cost would otherwise land entirely on whichever address is
    // measured first and look like a leak.
    for (let i = 0; i < SAMPLES; i += 1) await once(KNOWN);

    // Three groups, not two. The second known group is a control: it is the
    // same address measured twice, so whatever difference appears between those
    // two runs is the machine, not the handler.
    //
    // Without it this test asserted a fixed 5 ms bound on wall-clock HTTP
    // timings, which a shared CI runner cannot hold — and the failures proved
    // it, with the *sign* of the difference flipping between attempts of the
    // same run (unknown 44 ms slower, then known 20 ms slower). A leak has a
    // direction; noise does not.
    //
    // Interleaved rather than run as three blocks. Blocks assume the noise
    // holds still for the length of a block, and on a dev server shared with
    // three other test workers it does not: one slow patch landing inside the
    // middle block is attributed entirely to the unknown address and reads as
    // an 82 ms leak past a 12 ms control spread. That is what this test
    // reported on a loaded run. Interleaving puts any such patch into all three
    // groups at once, which is the only thing that makes the control a control.
    const controlA: number[] = [];
    const unknown: number[] = [];
    const controlB: number[] = [];

    for (let i = 0; i < SAMPLES; i += 1) {
      controlA.push(await once(KNOWN));
      unknown.push(await once(UNKNOWN));
      controlB.push(await once(KNOWN));
    }

    const median = (values: number[]): number => {
      const sorted = [...values].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)] as number;
    };

    const knownMedian = median([...controlA, ...controlB]);
    const unknownMedian = median(unknown);

    // The floor below which this environment cannot measure anything.
    const noise = Math.abs(median(controlA) - median(controlB));
    const signal = Math.abs(knownMedian - unknownMedian);

    // The stated exit criterion for this phase: an existing account must not be
    // distinguishable from a missing one by how long the answer takes.
    //
    // Expressed against the control rather than against a constant. On a quiet
    // machine `noise` is ~0 and this stays as tight as the old 5 ms bound; on a
    // loaded one it widens honestly. A real leak is systematic and would clear
    // the control's own spread, which is exactly what this refuses to let pass.
    expect(
      signal,
      `known ${knownMedian}ms vs unknown ${unknownMedian}ms, control spread ${noise}ms`,
    ).toBeLessThanOrEqual(Math.max(5, noise * 2));

    if (process.env.WORKERS_BUILD === '1') {
      // Against a real Workers build the binding is local and the handler
      // finishes in single-digit milliseconds, so the response time should sit
      // just above the constant-time budget. That is what proves the padding is
      // doing the work, rather than dev-server overhead masking the difference.
      expect(
        knownMedian,
        `expected the padded budget to dominate, got ${knownMedian}ms`,
      ).toBeGreaterThan(100);
      expect(knownMedian).toBeLessThan(400);
    }
  });
});
