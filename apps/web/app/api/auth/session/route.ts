import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { authFailure, serverError } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';
import { rotateSession, sessionCookie } from '@/lib/server/session';

/**
 * GET /api/auth/session
 *
 * Reports whether the caller has a live session, and rotates the token when it
 * is past half its life.
 *
 * Rotation happens here rather than on every request so that the common case
 * stays a single read. Note what the response does not include: no email, no
 * key material, nothing about the account. This endpoint answers one question —
 * "am I still signed in" — because that is all a client needs from it, and
 * anything more would be a second place for account data to leak from.
 */
export async function GET(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const current = await requireSession(request, context);
  if (!current) {
    return authFailure();
  }
  const { session, token } = current;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  };

  if (session.shouldRotate) {
    const issued = await rotateSession(context.db, context.pepper, session, token);
    headers['Set-Cookie'] = sessionCookie(issued);
  }

  return new Response(JSON.stringify({ status: 'ok', expiresAt: session.expiresAt.toISOString() }), {
    status: 200,
    headers,
  });
}
