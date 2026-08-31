import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { emailEnabled, send } from '@/lib/server/email';
import { checkLimit } from '@/lib/server/rate-limit';
import {
  badRequest,
  botCheckFailed,
  ok,
  serverError,
  tooManyRequests,
} from '@/lib/server/responses';
import { emailIndex } from '@/lib/server/secrets';
import {
  SIGNUP_CODE_TTL_MS,
  SIGNUP_TEST_HEADER,
  codeForResponse,
  issueSignupCode,
  sweepSignupCodes,
  verificationRequired,
} from '@/lib/server/signup-codes';
import { constantTime } from '@/lib/server/timing';
import { verifyTurnstile } from '@/lib/server/turnstile';

/**
 * POST /api/auth/signup/start
 *
 * Sends a six-digit code to an address, so that the account created afterwards
 * belongs to somebody who can read mail there.
 *
 * The answer is the same whether or not that address already has an account.
 * Saying "already registered" here would undo the care taken in prelogin and
 * signup to avoid becoming a way to test whether somebody has a vault, and this
 * route is the easiest place in the app to ask that question a million times.
 *
 * It always reports that a code was sent, including when no code was sent —
 * because the address is taken, because the mail provider refused, or because
 * this instance has no mail configured at all. What the caller learns is
 * exactly what somebody who does not own the address is entitled to learn.
 */

const schema = z.object({
  email: z.email().max(320),
});

export async function POST(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  let input: z.infer<typeof schema>;
  try {
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return badRequest();
    input = parsed.data;
  } catch {
    return badRequest();
  }

  // Shares the signup budget deliberately. Both routes are steps in one act,
  // and a separate allowance here would be a way to send mail to an address
  // repeatedly without ever finishing a signup.
  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'signup',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  // Before any mail is sent. A refused token should cost this server one HTTP
  // call, and should certainly not cost somebody else an email.
  if (!(await verifyTurnstile(context.turnstile, request))) return botCheckFailed();

  const { db, pepper, email } = context;

  const testMode = context.signupCodeTestMode;
  const required = verificationRequired(
    emailEnabled(email),
    testMode,
    request.headers.get(SIGNUP_TEST_HEADER),
  );

  // Only ever set in test mode, and `undefined` in every other configuration.
  let issued: string | undefined;

  // Padded, like the other auth routes. Sending mail takes a very different
  // amount of time from not sending it, and the difference is the answer to
  // "does this address already have an account".
  await constantTime(async () => {
    if (!required) return;

    await sweepSignupCodes(db);

    const index = await emailIndex(pepper, input.email);

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    /*
     * An address that already has an account is told so, and gets no code.
     *
     * The signup route has always said in a comment that "a real owner of the
     * address finds out via email". Nothing sent that email; the comment
     * described an intention. This is it.
     *
     * Only the owner of the inbox sees this, so it gives away nothing to
     * whoever typed the address in — they get the same answer either way. And
     * without a code they cannot finish, which is the point: an address that is
     * taken cannot be taken again.
     */
    if (existing.length > 0) {
      await send(email, {
        to: input.email,
        subject: 'Somebody tried to create a Core account with your address',
        text: [
          'Someone entered this address on the Core signup form.',
          '',
          'You already have an account here, so nothing was created and nothing',
          'has changed. If that was you, sign in instead — and if you cannot,',
          'use the unlock link on the sign-in page.',
          '',
          'If it was not you, there is nothing to do. Whoever it was learned',
          'nothing: the form answers the same way whether or not an address is',
          'registered.',
        ].join('\n'),
      });
      return;
    }

    const code = await issueSignupCode(db, index);
    issued = codeForResponse(testMode, code);

    if (!emailEnabled(email)) return;

    const minutes = Math.round(SIGNUP_CODE_TTL_MS / 60_000);

    await send(email, {
      to: input.email,
      subject: 'Your Core signup code',
      text: [
        `Your code is ${code}`,
        '',
        `It is valid for ${minutes} minutes and can be used once.`,
        '',
        'If you did not start creating a Core account, nothing has been created',
        'and you can ignore this. Somebody typed this address into a signup form;',
        'that is all that has happened, and it is why the code exists.',
      ].join('\n'),
    });
  });

  return ok({
    status: 'ok',
    verificationRequired: required,
    ...(issued ? { code: issued } : {}),
  });
}
