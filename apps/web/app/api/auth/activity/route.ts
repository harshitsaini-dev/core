import { auditLog } from '@core/db';
import { desc, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * What has happened to this account.
 *
 * Sign-ins, failures, lockouts, password changes — the events somebody would
 * want to see if they suspected another person had been in their vault, which
 * is the only reason this screen exists.
 *
 * What it returns is deliberately thin. The address and the user agent are
 * stored hashed with a server-side pepper and are not sent, because they cannot
 * be un-hashed and a hash on screen would be noise pretending to be evidence.
 * The country is sent: "a sign-in from a country you have never been in" is the
 * one thing here somebody can actually act on.
 */

/** Enough to cover a suspicious week without paging. */
const LIMIT = 100;

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
      id: auditLog.id,
      event: auditLog.event,
      geoCountry: auditLog.geoCountry,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.userId, current.session.userId))
    .orderBy(desc(auditLog.createdAt))
    .limit(LIMIT);

  return ok({
    events: rows.map((row) => ({
      id: row.id,
      event: row.event,
      country: row.geoCountry,
      at: row.createdAt?.getTime() ?? null,
    })),
  });
}
