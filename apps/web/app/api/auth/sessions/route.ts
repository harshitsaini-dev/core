import { sessions } from '@core/db';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { revokeSession } from '@/lib/server/session';
import { requireSession } from '@/lib/server/session-guard';

/**
 * The sessions that can currently open this account.
 *
 * The actionable half of the activity screen. Seeing that somebody signed in
 * from another country is only useful if there is something to do about it, and
 * this is the something: end that session, from here, now.
 *
 * What a session row can say about itself is thin, and the UI is written to
 * match rather than to imply more. Nothing is stored about the device — no
 * address, no user agent, not even hashed — so a session is "this one" or "one
 * that started three days ago", and that is the whole vocabulary. Naming them
 * would mean recording a fingerprint for every sign-in, which is a worse trade
 * than a vaguer list.
 */

/** Live: not revoked, not expired. */
function live(userId: string) {
  return and(
    eq(sessions.userId, userId),
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, new Date()),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
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
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const rows = await context.db
    .select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      expiresAt: sessions.expiresAt,
    })
    .from(sessions)
    .where(live(current.session.userId))
    .orderBy(desc(sessions.createdAt));

  return ok({
    sessions: rows.map((row) => ({
      id: row.id,
      startedAt: row.createdAt?.getTime() ?? null,
      expiresAt: row.expiresAt.getTime(),
      // Marked here rather than compared in the browser. The client has no way
      // to know its own session id — the token is in an HttpOnly cookie it
      // cannot read, which is the point of putting it there.
      current: row.id === current.session.id,
    })),
  });
}

const revokeSchema = z.object({ id: z.string().min(1).max(200) });

/**
 * End one session.
 *
 * Scoped to the caller's own sessions by the same condition that lists them, so
 * an id belonging to somebody else matches nothing. The answer is 200 either
 * way: a 404 for an unknown id would confirm which ids are real.
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
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  let input: z.infer<typeof revokeSchema>;
  try {
    input = revokeSchema.parse(await request.json());
  } catch {
    return badRequest();
  }

  const owned = await context.db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(live(current.session.userId), eq(sessions.id, input.id)))
    .limit(1);

  if (owned.length > 0) {
    await revokeSession(context.db, input.id);
    await record(context.db, context.pepper, request, current.session.userId, 'session_revoked');
  }

  return ok({ status: 'ok' });
}
