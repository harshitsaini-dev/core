import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { redeemToken } from '@/lib/server/email-tokens';
import { checkLimit } from '@/lib/server/rate-limit';
import { badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';

/**
 * Redeem a link that lifts a lockout.
 *
 * All this does is set `failedAttempts` to zero and `lockedUntil` to null. No
 * session is issued, no cookie is set, nothing is returned that could be used
 * to reach a vault — the caller is sent back to the sign-in form to type their
 * master password, exactly as if the fifteen minutes had elapsed.
 *
 * That is the entire point of the feature and the reason it is safe to send by
 * email. Somebody reading the mailbox learns that an account exists and can
 * shorten a wait. They cannot read an item.
 */

const schema = z.object({ token: z.string().min(1).max(200) });

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

  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await request.json());
  } catch {
    return badRequest();
  }

  const userId = await redeemToken(context.db, input.token, 'unlock');

  // The same answer for a token that was wrong, expired, already used, or
  // never existed. A distinguishable rejection would let somebody test tokens,
  // and there is nothing useful to say about which kind of failure it was.
  if (!userId) return ok({ status: 'ok' });

  await context.db
    .update(users)
    .set({ failedAttempts: 0, lockedUntil: null })
    .where(eq(users.id, userId));

  await record(context.db, context.pepper, request, userId, 'account_unlocked');

  return ok({ status: 'ok' });
}
