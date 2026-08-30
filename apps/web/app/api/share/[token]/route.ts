import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { burnShare, peekShare } from '@/lib/server/shares';

/**
 * Reading a shared secret.
 *
 * No session: the point of a link is that the person opening it does not have
 * an account here.
 *
 * `GET` says whether there is something to open. `POST` opens it, once. That
 * split is not tidiness — a one-time link pasted into a chat is fetched by the
 * preview bot before the recipient sees it, and if `GET` burned the share the
 * crawler would take the only view and the person it was for would find an
 * empty page and no way to tell why.
 *
 * Both answer the same way for a link that never existed, one already opened,
 * and one that expired. Distinguishing them would turn this into an oracle for
 * whether a guessed token was ever real.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
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

  const { token } = await params;
  const found = await peekShare(context.db, token);

  return ok(found.status === 'ready' ? { status: 'ready', expiresAt: found.expiresAt } : gone());
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<Response> {
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

  const { token } = await params;
  const payload = await burnShare(context.db, token);

  return ok(payload === null ? gone() : { status: 'ready', payload });
}

/** One answer for never-existed, already-opened and expired. */
function gone(): { status: 'gone' } {
  return { status: 'gone' };
}
