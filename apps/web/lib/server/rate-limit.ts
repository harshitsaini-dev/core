import type { Bytes } from '@core/crypto';
import { serverTag } from './secrets';

/**
 * Rate limiting.
 *
 * A token bucket per caller per endpoint, held in Workers KV. Buckets rather
 * than a fixed window because real traffic is bursty: a person opening the app
 * fires several requests at once and then nothing for a minute, and a fixed
 * window either rejects that burst or has to be set so high it stops nothing.
 *
 * **What this does not do, and why it is written down.** KV is eventually
 * consistent. Two requests arriving in different Cloudflare locations at the
 * same moment can both read the same bucket and both spend the last token, and
 * a write takes a moment to be visible everywhere. So this is a throttle, not a
 * counter: it reliably stops sustained guessing from one place, and it does not
 * guarantee an exact ceiling under a distributed burst.
 *
 * That is an acceptable trade here because it is the second line of defence.
 * The first is Argon2id — every guess costs the attacker real time and memory
 * on their own hardware before a request is ever sent — and the third is the
 * account lockout below. A precise limiter would need a strongly consistent
 * store per key, which on this stack means a Durable Object per account, and
 * that is a lot of machinery to make an approximate bound exact when the exact
 * bound is not what stops the attack.
 */

export interface Limit {
  /** The most that can be spent in one burst. */
  readonly capacity: number;
  /** How fast the bucket refills, in tokens per second. */
  readonly refillPerSecond: number;
}

/**
 * Per-endpoint limits.
 *
 * `login` is the tight one: five attempts, refilling at five a minute. A person
 * who has mistyped their password five times in a minute is not about to get it
 * right on the sixth, and an attacker gets 7,200 guesses a day against a
 * password that Argon2id already makes expensive to try.
 *
 * `prelogin` is looser because it is not a guess — it is the lookup that has to
 * happen before a legitimate client can derive anything, and a phone on a flaky
 * connection may retry it. It is still limited, because it is the endpoint an
 * enumeration sweep would point at first.
 *
 * `sync` is generous. It is authenticated, it is the app doing its job, and a
 * vault with a few hundred items catching up after a week offline is a normal
 * thing rather than an attack.
 */
export const LIMITS = {
  login: { capacity: 5, refillPerSecond: 5 / 60 },
  signup: { capacity: 3, refillPerSecond: 3 / 600 },
  prelogin: { capacity: 20, refillPerSecond: 20 / 60 },
  recover: { capacity: 3, refillPerSecond: 3 / 900 },
  sync: { capacity: 100, refillPerSecond: 100 / 60 },
} as const satisfies Record<string, Limit>;

export type Endpoint = keyof typeof LIMITS;

export interface Bucket {
  readonly tokens: number;
  /** Milliseconds since the epoch, as the server saw it. */
  readonly updatedAt: number;
}

export interface Decision {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Whole seconds until one token is available. Zero when allowed. */
  readonly retryAfter: number;
  readonly bucket: Bucket;
}

/**
 * Spend a token, given the bucket as it was last written.
 *
 * Split out from the storage so the arithmetic can be tested without a KV
 * namespace and without waiting for real time to pass — which matters, because
 * the parts of a rate limiter that go wrong are the boundaries, and those are
 * unreachable if the only way to reach them is to wait.
 */
export function spend(bucket: Bucket | null, limit: Limit, now: number): Decision {
  const previous = bucket ?? { tokens: limit.capacity, updatedAt: now };

  // Elapsed time is clamped at zero. A clock that went backwards — and on a
  // distributed edge the "clock" is several clocks — must not mint tokens.
  const elapsedSeconds = Math.max(0, (now - previous.updatedAt) / 1000);

  const refilled = Math.min(
    limit.capacity,
    previous.tokens + elapsedSeconds * limit.refillPerSecond,
  );

  if (refilled < 1) {
    return {
      allowed: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((1 - refilled) / limit.refillPerSecond)),
      // Written back so the refill is measured from now rather than from the
      // last *allowed* request. Otherwise a caller who keeps hammering while
      // blocked would accumulate credit for the time they spent being refused.
      bucket: { tokens: refilled, updatedAt: now },
    };
  }

  return {
    allowed: true,
    remaining: Math.floor(refilled - 1),
    retryAfter: 0,
    bucket: { tokens: refilled - 1, updatedAt: now },
  };
}

/**
 * How long an idle bucket is worth keeping.
 *
 * Once it has refilled to capacity it is indistinguishable from no bucket at
 * all, so it expires. This is what stops KV filling with one key per address
 * that ever touched the service.
 */
export function ttlSeconds(bucket: Bucket, limit: Limit): number {
  const missing = Math.max(0, limit.capacity - bucket.tokens);
  // KV rejects anything under 60.
  return Math.max(60, Math.ceil(missing / limit.refillPerSecond) + 60);
}

/**
 * The key for a caller.
 *
 * The address is hashed under a key derived from the pepper, never stored raw.
 * A rate-limit namespace is a log of who used the service and when, and this
 * one sits in infrastructure the threat model already treats as untrusted. The
 * hash is enough to count against, and useless for anything else.
 */
export async function callerKey(
  pepper: Bytes,
  endpoint: Endpoint,
  address: string,
): Promise<string> {
  return `rl:${endpoint}:${await serverTag(pepper, 'rateLimit', address)}`;
}

/** Read, spend, write. */
export async function consume(
  kv: KVNamespace,
  pepper: Bytes,
  endpoint: Endpoint,
  address: string,
  now: number = Date.now(),
): Promise<Decision> {
  const limit = LIMITS[endpoint];
  const key = await callerKey(pepper, endpoint, address);

  let stored: Bucket | null = null;
  try {
    stored = await kv.get<Bucket>(key, 'json');
  } catch {
    // A limiter that fails closed takes the whole service down with it when the
    // store has a bad minute. Argon2id and the account lockout are still doing
    // their jobs, so this fails open and says so.
    console.warn(`rate limit store unreadable for ${endpoint}`);
    return { allowed: true, remaining: 0, retryAfter: 0, bucket: { tokens: 0, updatedAt: now } };
  }

  const decision = spend(stored, limit, now);

  try {
    await kv.put(key, JSON.stringify(decision.bucket), {
      expirationTtl: ttlSeconds(decision.bucket, limit),
    });
  } catch {
    console.warn(`rate limit store unwritable for ${endpoint}`);
  }

  return decision;
}

/**
 * Extra padding after repeated failures from the same caller (RL-03).
 *
 * Doubling per failure, capped, so a guessing loop slows to a crawl while a
 * person who mistyped their password twice notices nothing.
 *
 * It is keyed on the caller, never on the account. That is not a detail: the
 * response time on this path must not depend on anything the server knows about
 * whether the account exists, or the padding that makes login constant-time
 * would itself become the oracle it was built to close.
 */
export function failureDelayMs(consecutiveFailures: number, base = 250, cap = 8000): number {
  if (consecutiveFailures <= 1) return 0;
  return Math.min(cap, base * 2 ** (consecutiveFailures - 2));
}

/**
 * The header a test uses to name itself. See `callerAddress`.
 */
export const TEST_CALLER_HEADER = 'x-core-caller';

/**
 * Who is asking.
 *
 * `cf-connecting-ip` is set by Cloudflare and cannot be forged by a client, so
 * it is preferred whenever it is there — which, on the deployment this is built
 * for, is always. `x-forwarded-for` is the fallback for a self-hosted instance
 * behind some other proxy, and it is only ever consulted when the trustworthy
 * header is absent, so an attacker on the real deployment cannot rotate it to
 * shed their bucket.
 *
 * When neither is present the caller cannot be told apart from anyone else, and
 * this returns null rather than lumping the whole world into one bucket. That
 * is a deliberate choice with a cost: an instance exposed directly to the
 * internet, with no proxy setting either header, has no rate limiting. It is
 * the honest behaviour, because the alternative — one shared bucket — is a
 * limiter any single visitor can exhaust for everybody, which is a denial of
 * service wearing a seatbelt. The requirement is in self-hosting.md and warned
 * about below.
 *
 * ## Test mode
 *
 * `testMode` exists because of something that only turns up when you run the
 * thing: locally, workerd sets `cf-connecting-ip` itself, so the limiter is
 * fully live and every test in the suite shares one address. Three signups per
 * ten minutes then means the fourth test fails, and the next four hundred after
 * it.
 *
 * So in test mode the caller is whatever the `x-core-caller` header says, and a
 * request without it is not limited at all. That gives each test its own bucket
 * and leaves the rest of the suite alone.
 *
 * It is switched on by an environment variable that exists in `.dev.vars` and
 * in the CI workflows, and nowhere else. Production ignores the header
 * completely — it is not a header a client can use to escape a bucket, because
 * outside test mode it is never read.
 */
export function callerAddress(request: Request, testMode = false): string | null {
  if (testMode) return request.headers.get(TEST_CALLER_HEADER);

  const direct = request.headers.get('cf-connecting-ip');
  if (direct) return direct;

  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first) return first;

  return null;
}

/**
 * The whole check, for a route to call in one line.
 *
 * Returns the seconds to wait when the caller should be refused, and null when
 * they should be let through.
 */
export async function checkLimit(
  request: Request,
  kv: KVNamespace,
  pepper: Bytes,
  endpoint: Endpoint,
  testMode = false,
): Promise<number | null> {
  const address = callerAddress(request, testMode);

  if (address === null) {
    // Silent in test mode: there, an unnamed caller is the normal case and
    // means "this test is not about rate limiting". A warning on every request
    // is a warning nobody reads by the time it matters.
    if (!testMode) {
      console.warn(
        `no caller address on ${endpoint}: rate limiting is inactive. ` +
          'Put this instance behind a proxy that sets cf-connecting-ip or x-forwarded-for.',
      );
    }
    return null;
  }

  const decision = await consume(kv, pepper, endpoint, address);
  return decision.allowed ? null : decision.retryAfter;
}
