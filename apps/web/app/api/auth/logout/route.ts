import type { NextRequest } from 'next/server';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { serverError } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';
import { clearedSessionCookie, revokeAllSessions, revokeSession } from '@/lib/server/session';

/**
 * POST /api/auth/logout
 *
 * Revokes the current session, or every session when `?all=1`.
 *
 * Always answers 200, even for a caller with no session or an invalid one.
 * There is nothing to protect by refusing — the request asked for a state the
 * caller already has — and returning 401 here would let someone test whether a
 * token is live.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const cleared = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Set-Cookie': clearedSessionCookie(),
  };

  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  // A replayed token is handled inside requireSession, which revokes the whole
  // chain. Logout then has nothing left to do, and still answers 200.
  const current = await requireSession(request, context);

  if (current) {
    const everywhere = new URL(request.url).searchParams.get('all') === '1';
    if (everywhere) {
      await revokeAllSessions(context.db, current.session.userId);
    } else {
      await revokeSession(context.db, current.session.id);
    }

    // Recorded after the revocation, so the entry describes something that
    // actually happened, and through `record`, so it cannot turn a completed
    // sign-out into an error.
    await record(context.db, context.pepper, request, current.session.userId, 'logout');
  }

  return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: cleared });
}
