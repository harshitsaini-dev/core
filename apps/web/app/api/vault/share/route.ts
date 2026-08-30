import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';
import { MAX_SHARE_BYTES, SHARE_TTL_MS, createShare, sweepExpired } from '@/lib/server/shares';

/**
 * Put a ciphertext behind a one-time link.
 *
 * The body is already encrypted when it arrives, under a key generated in the
 * sender's browser and placed after the `#` of the link. This route stores
 * bytes it cannot read and returns the half of the link that identifies them.
 */
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
    'share',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  let payload: unknown;
  try {
    payload = ((await request.json()) as { payload?: unknown }).payload;
  } catch {
    return badRequest();
  }

  if (typeof payload !== 'string' || payload === '' || payload.length > MAX_SHARE_BYTES) {
    return badRequest();
  }

  // Cheap, and this is the only route the sender is guaranteed to hit. There is
  // no cron here, and an expired share is a ciphertext sitting in a table.
  await sweepExpired(context.db);

  const token = await createShare(context.db, current.session.userId, payload);

  // The token only. The key half never reaches this process, so there is
  // nothing here that could assemble a working link even by accident.
  return ok({ token, expiresIn: SHARE_TTL_MS });
}
