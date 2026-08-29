import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { emailEnabled, send } from '@/lib/server/email';
import { issueToken } from '@/lib/server/email-tokens';
import { checkLimit } from '@/lib/server/rate-limit';
import { badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { emailDecrypt, emailIndex } from '@/lib/server/secrets';

/**
 * Ask for a link that lifts a lockout.
 *
 * Ten wrong passwords locks an account for fifteen minutes. The window expires
 * on its own — nobody is ever permanently stranded, which is why the lockout
 * could be built before this existed — but somebody who mistyped their own
 * password ten times should not have to sit and wait for it.
 *
 * **The link does not sign anybody in.** It clears the lock; the master
 * password is still required afterwards, and the server still cannot open the
 * vault. A magic link that logged you in would make the mailbox equivalent to
 * the vault, and every claim this product makes would become a claim about
 * whoever runs the user's email.
 *
 * The answer is the same whether or not the address exists, whether or not it
 * is locked, and whether or not this instance can send mail at all. Anything
 * else turns this into the account-existence oracle that prelogin, signup and
 * login are all arranged to withhold.
 */

const schema = z.object({ email: z.string().email().max(320) });

export async function POST(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'login',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  /*
   * No Turnstile check here, deliberately.
   *
   * The first version had one, and it made the feature impossible to use: the
   * offer appears next to a failed sign-in, by which point the widget's token
   * is already spent — a token is single-use and the sign-in just used it. So
   * every request arrived without one and was refused with a 400 nobody saw,
   * because the button does not wait for an answer. The email simply never came.
   *
   * Leaving it off is defensible on its own terms rather than only convenient.
   * Reaching this endpoint usefully requires an account that is already locked,
   * which requires ten failed sign-ins, each of which *is* behind Turnstile and
   * the rate limiter. The expensive gate is upstream. What is left here is
   * capped by the same per-caller limiter above, sends only to an address that
   * already exists, and produces a link that cannot open a vault.
   */

  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await request.json());
  } catch {
    return badRequest();
  }

  // Everything below runs to the same answer. `sent: true` is a description of
  // what this endpoint does with a valid request, not a report about whether
  // an email left the building.
  const accepted = ok({ status: 'ok' });

  if (!emailEnabled(context.email)) return accepted;

  try {
    const { db, pepper } = context;
    const index = await emailIndex(pepper, input.email);

    const rows = await db
      .select({ id: users.id, emailEnc: users.emailEnc, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];
    if (!row) return accepted;

    // Only for an account that is actually locked. Otherwise this is a way to
    // have mail sent to any address somebody names, from a domain they do not
    // control — which is a spam relay with extra steps.
    const locked = row.lockedUntil !== null && row.lockedUntil.getTime() > Date.now();
    if (!locked) return accepted;

    const token = await issueToken(db, row.id, 'unlock');
    const base = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;

    await send(context.email, {
      to: await emailDecrypt(pepper, row.emailEnc),
      subject: 'Unlock your Core account',
      text:
        'Your Core account locked itself after ten failed sign-in attempts.\n\n' +
        'If that was you, this link lifts the lock straight away:\n\n' +
        `${base}/unlock?token=${token}\n\n` +
        'It works once and expires in fifteen minutes.\n\n' +
        'It does not sign you in and it does not open your vault — you will ' +
        'still need your master password. Nobody here can open it for you.\n\n' +
        'If it was not you, do nothing. The lock expires by itself in fifteen ' +
        'minutes, and whoever was guessing did not get in.

' +
        'Either way you are not locked out for good: the lock clears itself. ' +
        'This link only saves the wait.

— Core
',
    });
  } catch {
    // Same answer as every other path. An error here must not become the one
    // response that distinguishes a real address from an invented one.
    console.warn('unlock request failed; answering as normal');
  }

  return accepted;
}
