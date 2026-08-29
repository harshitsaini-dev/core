import { describe, expect, it, vi } from 'vitest';
import { LIMITS, checkLimit, failureDelayMs, spend, ttlSeconds } from './rate-limit';
import type { Bucket, Limit } from './rate-limit';

/** A KV namespace that is a Map, which is all the limiter needs of one. */
function memoryKv() {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => JSON.parse(store.get(key) ?? 'null') as unknown,
    put: async (key: string, value: string) => void store.set(key, value),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const PEPPER = new Uint8Array(32) as Uint8Array<ArrayBuffer>;

/**
 * The arithmetic, tested without KV and without waiting.
 *
 * A rate limiter goes wrong at its boundaries — the moment the last token is
 * spent, the moment one has refilled, the clock moving oddly — and every one of
 * those is unreachable if the only way to reach it is to wait for real time.
 */

const limit: Limit = { capacity: 5, refillPerSecond: 1 };
const T0 = 1_700_000_000_000;

function drain(count: number, at = T0): Bucket {
  let bucket: Bucket | null = null;
  for (let i = 0; i < count; i += 1) {
    bucket = spend(bucket, limit, at).bucket;
  }
  return bucket ?? { tokens: limit.capacity, updatedAt: at };
}

describe('spend', () => {
  it('starts full, so a first request is never refused', () => {
    const decision = spend(null, limit, T0);
    expect(decision.allowed).toBe(true);
    expect(decision.remaining).toBe(4);
  });

  it('allows exactly the capacity in a burst', () => {
    let bucket: Bucket | null = null;
    for (let i = 0; i < limit.capacity; i += 1) {
      const decision = spend(bucket, limit, T0);
      expect(decision.allowed, `request ${i + 1} of ${limit.capacity}`).toBe(true);
      bucket = decision.bucket;
    }

    expect(spend(bucket, limit, T0).allowed).toBe(false);
  });

  it('says how long to wait', () => {
    const decision = spend(drain(5), limit, T0);
    expect(decision.allowed).toBe(false);
    // One token a second, none left: a second.
    expect(decision.retryAfter).toBe(1);
  });

  it('never reports a wait of zero while refusing', () => {
    // A Retry-After of 0 tells a client to try immediately, which is how a
    // refusal turns into a tight loop.
    const barelyEmpty: Bucket = { tokens: 0.999, updatedAt: T0 };
    const decision = spend(barelyEmpty, limit, T0);

    expect(decision.allowed).toBe(false);
    expect(decision.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('refills over time', () => {
    const empty = drain(5);
    expect(spend(empty, limit, T0 + 1000).allowed).toBe(true);
  });

  it('refills proportionally rather than all at once', () => {
    const empty = drain(5);
    // Two seconds at one a second: two tokens, one spent, one left.
    expect(spend(empty, limit, T0 + 2000).remaining).toBe(1);
  });

  it('never refills past capacity, however long it has been idle', () => {
    const empty = drain(5);
    const afterAges = spend(empty, limit, T0 + 86_400_000);

    expect(afterAges.remaining).toBe(limit.capacity - 1);
  });

  it('mints nothing when the clock goes backwards', () => {
    // On a distributed edge the "clock" is several clocks. A bucket written a
    // moment ago by a machine running slightly fast must not become free
    // requests.
    const empty = drain(5);
    expect(spend(empty, limit, T0 - 60_000).allowed).toBe(false);
  });

  it('does not credit a caller for the time they spent being refused', () => {
    // Otherwise hammering while blocked is rewarded: each refusal would leave
    // the bucket dated to the last *allowed* request and the wait would never
    // actually elapse.
    let bucket = drain(5);

    // Half a second of refusals, then half a second more.
    for (let t = 100; t <= 500; t += 100) {
      const decision = spend(bucket, limit, T0 + t);
      expect(decision.allowed).toBe(false);
      bucket = decision.bucket;
    }

    expect(spend(bucket, limit, T0 + 900).allowed).toBe(false);
    expect(spend(bucket, limit, T0 + 1600).allowed).toBe(true);
  });
});

describe('ttlSeconds', () => {
  it('keeps a spent bucket at least until it has refilled', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 };
    // Five tokens at one a second, plus a margin.
    expect(ttlSeconds(empty, limit)).toBeGreaterThanOrEqual(5);
  });

  it('never returns less than the minimum KV accepts', () => {
    const full: Bucket = { tokens: limit.capacity, updatedAt: T0 };
    expect(ttlSeconds(full, limit)).toBeGreaterThanOrEqual(60);
  });

  it('is longer for a slower refill', () => {
    const empty: Bucket = { tokens: 0, updatedAt: T0 };
    const slow: Limit = { capacity: 5, refillPerSecond: 1 / 60 };

    expect(ttlSeconds(empty, slow)).toBeGreaterThan(ttlSeconds(empty, limit));
  });
});

describe('the configured limits', () => {
  it('lets a person mistype a password a few times', () => {
    // Five in a burst. Someone who has got it wrong five times in a minute is
    // not about to get it right on the sixth.
    expect(LIMITS.login.capacity).toBeGreaterThanOrEqual(3);
    expect(LIMITS.login.capacity).toBeLessThanOrEqual(10);
  });

  it('holds login well under a thousand guesses a day', () => {
    const perDay = LIMITS.login.refillPerSecond * 86_400;
    expect(perDay).toBeLessThan(10_000);
  });

  it('is looser on prelogin than on login', () => {
    // Prelogin is not a guess: it is the lookup a legitimate client must make
    // before it can derive anything, and a flaky connection retries it.
    expect(LIMITS.prelogin.capacity).toBeGreaterThan(LIMITS.login.capacity);
  });

  it('is loosest on sync, which is the app doing its job', () => {
    for (const [name, entry] of Object.entries(LIMITS)) {
      if (name === 'sync') continue;
      expect(LIMITS.sync.capacity, `sync should be looser than ${name}`).toBeGreaterThan(
        entry.capacity,
      );
    }
  });

  it('refills every bucket eventually', () => {
    // A limit that never refills is a ban, and nothing here is meant to be one.
    for (const [name, entry] of Object.entries(LIMITS)) {
      expect(entry.refillPerSecond, `${name} never refills`).toBeGreaterThan(0);
    }
  });
});

describe('failureDelayMs', () => {
  it('costs a first mistake nothing', () => {
    expect(failureDelayMs(0)).toBe(0);
    expect(failureDelayMs(1)).toBe(0);
  });

  it('doubles', () => {
    expect(failureDelayMs(2)).toBe(250);
    expect(failureDelayMs(3)).toBe(500);
    expect(failureDelayMs(4)).toBe(1000);
  });

  it('stops doubling before it becomes a hang', () => {
    expect(failureDelayMs(50)).toBe(8000);
    expect(failureDelayMs(1000)).toBe(8000);
  });

  it('is monotonic', () => {
    let previous = -1;
    for (let attempts = 0; attempts < 40; attempts += 1) {
      const delay = failureDelayMs(attempts);
      expect(delay).toBeGreaterThanOrEqual(previous);
      previous = delay;
    }
  });
});

describe('refusal logging', () => {
  /*
   * Only refusals are logged. Logging the allowed ones would be logging every
   * request the service ever serves, which is a traffic log by another name —
   * and this product's whole position is that it does not keep one.
   */

  function request(ip = '203.0.113.7'): Request {
    return new Request('https://example.test/api/auth/login', {
      headers: { 'cf-connecting-ip': ip, 'cf-ipcountry': 'IN' },
    });
  }

  it('says nothing while requests are allowed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = memoryKv();

    await checkLimit(request(), kv, PEPPER, 'login');

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('writes one filterable line when a caller is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = memoryKv();

    // Past the login bucket's capacity.
    for (let n = 0; n < LIMITS.login.capacity + 1; n += 1) {
      await checkLimit(request(), kv, PEPPER, 'login');
    }

    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('{'));
    expect(lines.length).toBeGreaterThan(0);

    const entry = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(entry['event']).toBe('rate_limited');
    expect(entry['endpoint']).toBe('login');
    expect(entry['country']).toBe('IN');

    warn.mockRestore();
  });

  it('never writes the address it is counting', async () => {
    // The caller is identified by the same hash the limiter counts against, so
    // two refusals from one address are visibly the same address without the
    // address appearing anywhere.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const kv = memoryKv();

    for (let n = 0; n < LIMITS.login.capacity + 1; n += 1) {
      await checkLimit(request('198.51.100.42'), kv, PEPPER, 'login');
    }

    const written = warn.mock.calls.map((call) => String(call[0])).join('\n');
    expect(written).not.toContain('198.51.100.42');

    warn.mockRestore();
  });

  it('gives one address the same tag twice, and two addresses different ones', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const tagFor = async (ip: string): Promise<string> => {
      const kv = memoryKv();
      for (let n = 0; n < LIMITS.login.capacity + 2; n += 1) {
        await checkLimit(request(ip), kv, PEPPER, 'login');
      }
      const lines = warn.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith('{'));
      warn.mockClear();
      return (JSON.parse(lines[0] as string) as { caller: string }).caller;
    };

    expect(await tagFor('203.0.113.1')).toBe(await tagFor('203.0.113.1'));
    expect(await tagFor('203.0.113.1')).not.toBe(await tagFor('203.0.113.2'));

    warn.mockRestore();
  });
});
