import { auditLog, users } from '@core/db';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  deriveAuthVerifier,
} from '@core/crypto';
import { eq, sql } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { LIMITS, callerAddress, consume, failureDelayMs } from '@/lib/server/rate-limit';
import { authFailure, badRequest, serverError, tooManyRequests } from '@/lib/server/responses';
import { emailIndex, hashIp, hashUserAgent } from '@/lib/server/secrets';
import { issueSession, sessionCookie } from '@/lib/server/session';
import { AUTH_RESPONSE_BUDGET_MS, constantTime } from '@/lib/server/timing';

/**
 * Run a counter update without letting it decide the request.
 *
 * Both of these are bookkeeping: one records a failure, the other clears the
 * record after a success. Neither should be able to change the answer, and
 * letting them throw does exactly that — twice over.
 *
 * On the success path it turns an authenticated login into a 500, which is
 * absurd: the person proved who they are and the server refuses them because a
 * housekeeping write lost a lock.
 *
 * On the failure path it is worse than absurd. That update only runs when a row
 * was found, so an exception there answers 500 for an account that exists and
 * 401 for one that does not — rebuilding, out of the lockout machinery, the
 * exact enumeration oracle every other decision on this path was arranged to
 * close.
 *
 * Found when a local D1 replica shared by four test workers lost a write. Real
 * D1 serialises writes and this is far less likely there, which is the reason
 * to handle it rather than to rely on it.
 */
async function bookkeeping(work: Promise<unknown>): Promise<void> {
  try {
    await work;
  } catch {
    console.warn('login counter update failed; the login itself is unaffected');
  }
}

/**
 * Account lockout (RL-06).
 *
 * Ten consecutive failures lock the account for fifteen minutes, and the window
 * expires on its own. That last part is the whole design: an earlier note in
 * this file worried that enforcing a lockout would strand a real user until a
 * magic-link path existed, and a self-healing window answers it — nobody is
 * ever locked out permanently, and no second channel is needed to get back in.
 *
 * **A locked account answers exactly like a wrong password.** Same status, same
 * body, same padded time. That is not a cosmetic choice: saying "this account is
 * locked" would confirm the account exists, which is the one thing every other
 * decision on this path has been arranged to avoid.
 *
 * It costs something real, and it is worth being plain about both halves. A
 * legitimate user who mistypes their password ten times is then told
 * "incorrect" for fifteen minutes while their correct password is refused, with
 * nothing explaining why. And anyone who knows an email address can keep that
 * account locked by failing on purpose. Neither is nice; both are bounded, and
 * neither loses data. The alternative — a clear message — trades a permanent
 * enumeration oracle for a temporary inconvenience, which is the wrong way
 * round for a product whose entire claim is that the server knows nothing.
 */
const LOCKOUT_THRESHOLD = 10;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

/**
 * POST /api/auth/login
 *
 * Verifies the Auth Key the client derived from its master password, and issues
 * a session.
 *
 * What this route can and cannot do is worth being precise about. It proves the
 * caller knows the master password, and it hands back the wrapped keys. It does
 * **not** unlock anything: those keys are encrypted under a Master Key that only
 * the browser can derive, so the server hands over material it cannot itself
 * use. A stolen session lets an attacker fetch and destroy ciphertext — bad, and
 * why sessions are revocable — but not read it.
 */

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  authKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url'),
});

const MAX_BODY_BYTES = 2 * 1024;

interface LoginOutcome {
  readonly ok: boolean;
  readonly userId?: string;
  readonly keys?: {
    accountKeyWrapped: string;
    publicKey: string;
    privateKeyWrapped: string;
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof loginSchema>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = loginSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return badRequest();
    input = parsed.data;
  } catch {
    return badRequest();
  }

  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const { db, pepper } = context;

  // Before any work. The decision depends only on the caller's own address, so
  // it reveals nothing about whether any account exists — which is why it can
  // sit outside the constant-time block without becoming an oracle of its own.
  //
  // Login reads the bucket itself rather than calling the shared helper,
  // because it wants the number as well as the verdict: how much of the
  // caller's allowance is already gone is what drives the delay below.
  const address = callerAddress(request, context.rateLimitTestMode);
  const decision = address === null ? null : await consume(context.kv, pepper, 'login', address);

  if (decision && !decision.allowed) return tooManyRequests(decision.retryAfter);

  /**
   * Progressive delay (RL-03).
   *
   * Measured against the caller and never against the account. A budget that
   * grew with an account's failure count would make a much-attacked address
   * answer more slowly than an address with no account at all — which is
   * precisely the oracle the padding exists to close.
   *
   * Counted from the caller's own bucket, so it costs no extra storage. On this
   * endpoint a burst is what a guessing loop looks like; a person signing in
   * makes one request.
   */
  const attempts = decision === null ? 0 : LIMITS.login.capacity - decision.remaining;
  const budget = AUTH_RESPONSE_BUDGET_MS + failureDelayMs(attempts);

  const { value: outcome } = await constantTime(async (): Promise<LoginOutcome> => {
    const index = await emailIndex(pepper, input.email);

    const rows = await db
      .select({
        id: users.id,
        failedAttempts: users.failedAttempts,
        lockedUntil: users.lockedUntil,
        authVerifier: users.authVerifier,
        accountKeyWrapped: users.accountKeyWrapped,
        publicKey: users.publicKey,
        privateKeyWrapped: users.privateKeyWrapped,
      })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];

    // Computed whether or not a row was found. Skipping the HMAC for unknown
    // addresses would make "no such user" measurably cheaper than "wrong
    // password", which is precisely the distinction this must not expose.
    const submitted = await deriveAuthVerifier(base64UrlToBytes(input.authKey), pepper);
    const submittedEncoded = bytesToBase64Url(submitted);

    if (!row) {
      // Compare against a value that cannot match, so the comparison itself
      // still happens and still costs the same.
      constantTimeEqual(submitted, submitted.slice().fill(0));
      return { ok: false };
    }

    const matches = constantTimeEqual(
      base64UrlToBytes(submittedEncoded),
      base64UrlToBytes(row.authVerifier),
    );

    const locked = row.lockedUntil !== null && row.lockedUntil.getTime() > Date.now();

    if (!matches || locked) {
      const attempts = row.failedAttempts + 1;

      await bookkeeping(
        db
          .update(users)
          .set({
            failedAttempts: sql`${users.failedAttempts} + 1`,
            ...(attempts >= LOCKOUT_THRESHOLD && !locked
              ? { lockedUntil: new Date(Date.now() + LOCKOUT_WINDOW_MS) }
              : {}),
          })
          .where(eq(users.id, row.id)),
      );

      return { ok: false, userId: row.id };
    }

    await bookkeeping(
      db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, row.id)),
    );

    return {
      ok: true,
      userId: row.id,
      keys: {
        accountKeyWrapped: row.accountKeyWrapped,
        publicKey: row.publicKey,
        privateKeyWrapped: row.privateKeyWrapped,
      },
    };
  }, budget);

  const ipHash = await hashIp(pepper, request.headers.get('cf-connecting-ip') ?? 'unknown');
  const uaHash = await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown');
  const geoCountry = request.headers.get('cf-ipcountry');

  if (outcome.userId) {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId: outcome.userId,
      event: outcome.ok ? 'login' : 'login_failed',
      ipHash,
      uaHash,
      geoCountry,
    });
  }

  if (!outcome.ok || !outcome.userId || !outcome.keys) {
    // One response for an unknown address and for a wrong password. Anything
    // else turns login into the enumeration oracle prelogin avoids being.
    return authFailure();
  }

  const issued = await issueSession(db, pepper, outcome.userId);

  return new Response(JSON.stringify({ status: 'ok', ...outcome.keys }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Set-Cookie': sessionCookie(issued),
    },
  });
}
