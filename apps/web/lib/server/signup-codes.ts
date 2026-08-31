import { signupCodes } from '@core/db';
import type { Database } from '@core/db';
import { bytesToBase64Url, constantTimeEqual, randomInt, utf8ToBytes } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import { and, eq, gt, lte } from 'drizzle-orm';

/**
 * Proving an address before an account exists.
 *
 * Without this, a vault could be created on any address at all: signup took an
 * email and made an account, and the only thing an address had to be was
 * well-formed. Two consequences, and the second is the worse one.
 *
 * Somebody could take an address they do not own — and because signup reports
 * success either way to avoid becoming an enumeration oracle, the real owner
 * would later be told their own address was fine to register while quietly
 * getting nothing. The address was gone and nobody was told.
 *
 * And the account's own recovery depends on the address. A vault whose owner
 * cannot read the mail for it is a vault with no way back at all: there is no
 * password reset here, and the unlock link is the one thing that survives a
 * lockout.
 *
 * So the code comes first and the account comes second. Nothing is written to
 * `users` until somebody has shown they can read mail at the address.
 */

/**
 * Fifteen minutes, matching the unlock and device tokens.
 *
 * Long enough to switch to a mail client and back, short enough that a code
 * sitting in an inbox is not a standing claim on an address.
 */
export const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Three wrong guesses and the code is destroyed.
 *
 * Six digits is a million possibilities, which sounds like a lot and is not
 * when a guess costs one request. The rate limiter bounds how fast; this bounds
 * how many, per code, which is the part that actually matters. Getting a new
 * one costs nothing but asking again.
 */
export const SIGNUP_CODE_ATTEMPT_LIMIT = 3;

/**
 * The header a test uses to exercise verification without a mail provider.
 *
 * The whole flow only runs when this instance can send mail, which the test
 * environment deliberately cannot: adding a real provider to the suite would
 * mean every one of eight hundred signups making an HTTPS call to somebody
 * else's service. So the path that matters most — an address proved before an
 * account exists — would otherwise be the one path with no test at all.
 *
 * Same shape as the rate limiter's test mode next door, for the same reasons.
 * It is read only when an environment variable says so, that variable lives in
 * `.dev.vars` and the CI workflows and nowhere else, and production never looks
 * at the header. Outside test mode this is not a header a client can send to
 * change anything.
 */
export const SIGNUP_TEST_HEADER = 'x-core-signup-test';

/**
 * Whether this request should behave as if mail were configured.
 *
 * Split out and this small so the rule can be tested both ways without a
 * server: the danger of a flag like this is not what it does when it is on, it
 * is being on when nobody meant it to be.
 */
export function verificationRequired(
  mailConfigured: boolean,
  testMode: boolean,
  header: string | null,
): boolean {
  return mailConfigured || (testMode && header === 'required');
}

/**
 * The code to hand back in the response, or nothing.
 *
 * Only ever in test mode. In every other configuration a signup code exists in
 * one place — the email — and this returns `undefined`, which is what makes the
 * flow worth having at all.
 */
export function codeForResponse(testMode: boolean, code: string): string | undefined {
  return testMode ? code : undefined;
}

async function hash(code: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return bytesToBase64Url(new Uint8Array(digest) as Bytes);
}

/**
 * Mint a code for an address and return it, for the email to carry.
 *
 * Any earlier code for the same address is replaced. Two live codes for one
 * address is one more than anybody needs, and the older one is the one that has
 * been sitting somewhere longest.
 */
export async function issueSignupCode(db: Database, emailBlindIndex: string): Promise<string> {
  const code = String(randomInt(1_000_000)).padStart(6, '0');

  await db.delete(signupCodes).where(eq(signupCodes.emailBlindIndex, emailBlindIndex));

  await db.insert(signupCodes).values({
    id: crypto.randomUUID(),
    emailBlindIndex,
    codeHash: await hash(code),
    expiresAt: new Date(Date.now() + SIGNUP_CODE_TTL_MS),
  });

  return code;
}

/**
 * Spend a code, if it is the right one.
 *
 * The row is deleted on success rather than marked used: unlike an unlock
 * token, nothing later needs to know that this happened, and a spent row is a
 * hash somebody can work on offline for an address they are trying to take.
 *
 * A wrong guess increments the counter and destroys the code once it is spent.
 * Returning `false` for "wrong", "expired", "never existed" and "out of
 * attempts" is deliberate: distinguishing them would say whether a code is
 * outstanding for an address, which is a question about somebody else's inbox.
 */
export async function redeemSignupCode(
  db: Database,
  emailBlindIndex: string,
  code: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: signupCodes.id, codeHash: signupCodes.codeHash, attempts: signupCodes.attempts })
    .from(signupCodes)
    .where(
      and(eq(signupCodes.emailBlindIndex, emailBlindIndex), gt(signupCodes.expiresAt, new Date())),
    )
    .limit(1);

  const row = rows[0];
  if (!row || row.attempts >= SIGNUP_CODE_ATTEMPT_LIMIT) return false;

  // Constant time. The code is short, and an attacker holding one guess should
  // not learn how much of it was right from how long the answer took.
  const submitted = await hash(code);
  if (constantTimeEqual(utf8ToBytes(submitted), utf8ToBytes(row.codeHash))) {
    await db.delete(signupCodes).where(eq(signupCodes.id, row.id));
    return true;
  }

  const attempts = row.attempts + 1;
  if (attempts >= SIGNUP_CODE_ATTEMPT_LIMIT) {
    await db.delete(signupCodes).where(eq(signupCodes.id, row.id));
  } else {
    await db.update(signupCodes).set({ attempts }).where(eq(signupCodes.id, row.id));
  }

  return false;
}

/**
 * Drop what has expired.
 *
 * On the signup path's own requests, like the share sweep, because there is no
 * cron here. An expired row is only a hash of six digits, but it is also a
 * record that somebody started signing up with an address, and there is no
 * reason to keep that.
 */
export async function sweepSignupCodes(db: Database): Promise<void> {
  await db.delete(signupCodes).where(lte(signupCodes.expiresAt, new Date()));
}
