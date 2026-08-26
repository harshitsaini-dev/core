import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { serverError } from '@/lib/server/responses';
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  resolveSession,
  revokeAllSessions,
  revokeSession,
} from '@/lib/server/session';

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

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = await resolveSession(context.db, context.pepper, token);

  if (session) {
    const everywhere = new URL(request.url).searchParams.get('all') === '1';
    if (everywhere) {
      await revokeAllSessions(context.db, session.userId);
    } else {
      await revokeSession(context.db, session.id);
    }
  }

  return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: cleared });
}
