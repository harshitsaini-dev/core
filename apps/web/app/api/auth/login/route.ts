import { SIZES } from '@core/shared';
import { users } from '@core/db';
import type { Bytes } from '@core/crypto';
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
import { alert } from '@/lib/server/alerts';
import { isKnownDevice } from '@/lib/server/devices';
import { emailEnabled, send } from '@/lib/server/email';
import { issueToken } from '@/lib/server/email-tokens';
import { LOCKOUT_THRESHOLD, LOCKOUT_WINDOW_MS, windowInWords } from '@/lib/server/lockout';
import { record } from '@/lib/server/audit';
import { authFailure, badRequest, serverError, tooManyRequests } from '@/lib/server/responses';
import { verifyTurnstile } from '@/lib/server/turnstile';
import { emailDecrypt, emailIndex } from '@/lib/server/secrets';
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
  /** Needed to email a code; never returned to the caller. */
  readonly emailEnc?: string;
  /** This attempt is the one that crossed the threshold. */
  readonly lockedNow?: boolean;
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

  // After the limiter, before anything expensive. A refused token should cost
  // this server one HTTP call, not an Argon2id verification — and before the
  // constant-time block, so it cannot become a way to time the answer.
  if (!(await verifyTurnstile(context.turnstile, request))) return badRequest();

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
        emailEnc: users.emailEnc,
        accountKeyWrapped: users.accountKeyWrapped,
        publicKey: users.publicKey,
        privateKeyWrapped: users.privateKeyWrapped,
      })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];

    /*
     * Computed whether or not a row was found. Skipping the HMAC for unknown
     * addresses would make "no such user" measurably cheaper than "wrong
     * password", which is precisely the distinction this must not expose.
     *
     * Decoded defensively. The schema checks the base64url *alphabet*, and a
     * string can pass that and still be an impossible length — `encoding.ts`
     * says so where it throws. Unhandled, that reached here as an exception and
     * came back as a 500, which both crashes a request that should simply have
     * failed and hands back a response shape a wrong password never produces.
     *
     * A value that cannot be decoded is a value that cannot be the right key,
     * so it takes the same path as one that is merely wrong: hashed, compared,
     * refused.
     */
    let submittedBytes: Bytes;
    try {
      submittedBytes = base64UrlToBytes(input.authKey);
    } catch {
      submittedBytes = new Uint8Array(SIZES.key) as Bytes;
    }

    const submitted = await deriveAuthVerifier(submittedBytes, pepper);
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
      const lockedNow = attempts >= LOCKOUT_THRESHOLD && !locked;

      await bookkeeping(
        db
          .update(users)
          .set({
            failedAttempts: sql`${users.failedAttempts} + 1`,
            ...(lockedNow ? { lockedUntil: new Date(Date.now() + LOCKOUT_WINDOW_MS) } : {}),
          })
          .where(eq(users.id, row.id)),
      );

      // Reported back rather than logged here. Everything inside this block is
      // under the constant-time budget, and a write that only happens on the
      // tenth failure would be a write whose cost is visible.
      return { ok: false, userId: row.id, lockedNow };
    }

    await bookkeeping(
      db.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, row.id)),
    );

    return {
      ok: true,
      userId: row.id,
      emailEnc: row.emailEnc,
      keys: {
        accountKeyWrapped: row.accountKeyWrapped,
        publicKey: row.publicKey,
        privateKeyWrapped: row.privateKeyWrapped,
      },
    };
  }, budget);

  if (outcome.userId) {
    // Through `record`, which cannot throw. As a bare insert this ran only when
    // a user row had been found, so a failed write answered 500 for an address
    // that exists and 401 for one that does not — the enumeration oracle the
    // whole of this path is arranged to close, rebuilt out of a log line four
    // lines below the comment explaining why the counter above had to be
    // guarded against exactly this.
    await record(db, pepper, request, outcome.userId, outcome.ok ? 'login' : 'login_failed');

    // A second entry, so the moment an account locks is visible in the activity
    // list rather than only inferrable from ten failures in a row. Outside the
    // timed block for the reason given there; it only ever runs for an account
    // that exists and has already failed nine times, so it adds no signal about
    // whether an address is real.
    if (outcome.lockedNow) {
      await record(db, pepper, request, outcome.userId, 'account_locked');
      // Only on the attempt that crosses the threshold, not on every failure
      // after it. Ten emails for one guessing run is how somebody learns to
      // filter these out of sight.
      await alert(
        db,
        context.email,
        pepper,
        outcome.userId,
        'account_locked',
        request.headers.get('cf-ipcountry'),
      );
    }
  }

  if (!outcome.ok || !outcome.userId || !outcome.keys) {
    // One response for an unknown address and for a wrong password. Anything
    // else turns login into the enumeration oracle prelogin avoids being.
    return authFailure();
  }

  /*
   * A correct password from a browser this account has never verified.
   *
   * Not the sign-in that matters — people buy laptops — but the first one from
   * somewhere new, which is also what a stolen password looks like. So no
   * session is issued and a six-digit code goes to the address on the account.
   *
   * The code does not open the vault and cannot. It gates the *session*; the
   * master password was already required to get here and the keys are still
   * derived in the browser. Anything else would make the mailbox a second way
   * in, and this product's whole claim is that there is no second way in.
   *
   * Only reachable after a correct password, so answering differently here
   * leaks nothing: whoever is asking has already proved the account exists.
   *
   * Skipped entirely where the instance cannot send mail. An unconfigured
   * self-hosted copy must not be one where nobody can ever sign in.
   */
  let needsVerification = false;
  try {
    needsVerification =
      emailEnabled(context.email) && !(await isKnownDevice(db, outcome.userId, request));
  } catch {
    /*
     * Fails open, and that is a decision rather than an oversight.
     *
     * Two ways to be wrong here. Closed: an internal fault locks somebody out
     * of their own vault from every browser, and the only way back is a
     * redeploy. Open: a new control silently does not apply, which is the
     * behaviour this product had until today.
     *
     * The second is plainly the lesser one — the password is still required
     * either way, and this check only ever added a second step to a sign-in
     * that had already passed. A control that can lock out the person it
     * protects is worse than one that occasionally does not fire.
     */
    console.warn('device recognition failed; issuing a session without it');
  }

  if (needsVerification) {
    // The code and the mail together. If either fails there is nothing to
    // enter, so the same reasoning applies: let the sign-in through rather
    // than leave somebody holding a form for a code that was never sent.
    let code: string;
    try {
      code = await issueToken(db, outcome.userId, 'device');
    } catch {
      console.warn('could not issue a device code; issuing a session without it');
      code = '';
    }

    const delivered =
      code === ''
        ? false
        : await send(context.email, {
            to: await emailDecrypt(pepper, outcome.emailEnc ?? ''),
            subject: `${code} is your Core sign-in code`,
            text:
              `Somebody signed in to your Core vault with the right master password, from a ` +
              `device this account has not seen before${
                request.headers.get('cf-ipcountry')
                  ? ` in ${request.headers.get('cf-ipcountry')}`
                  : ''
              }.\n\n` +
              `The code is ${code}. It expires in ${windowInWords()} minutes and works once.\n\n` +
              'If that was you, enter it and this browser will be remembered.\n\n' +
              'If it was not, somebody has your master password. They cannot get in ' +
              'without this code — but change that password now, from a device you ' +
              'already use.\n\n— Core\n',
          });

    /*
     * Only hold the sign-in back if the code actually went out.
     *
     * A form asking for a code that was never sent is a locked door with no
     * key, and `send` already answers false rather than throwing when Resend
     * refuses or is unreachable. The check applies whenever it can be applied,
     * and gets out of the way when it cannot.
     */
    if (delivered) {
      return new Response(JSON.stringify({ status: 'verify' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
        },
      });
    }
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
