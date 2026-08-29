import type { NextRequest } from 'next/server';
import { alert } from './alerts';
import { record } from './audit';
import type { RequestContext } from './context';
import { SESSION_COOKIE, resolveSession, revokeAllSessions } from './session';
import type { ResolvedSession } from './session';

/**
 * Resolve the caller's session, handling token reuse.
 *
 * Every authenticated route goes through here rather than calling
 * `resolveSession` directly, so that the response to a replayed token is the
 * same everywhere. A rule applied in most places is not a rule.
 */
export async function requireSession(
  request: NextRequest,
  context: RequestContext,
): Promise<{ session: ResolvedSession; token: string } | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const lookup = await resolveSession(context.db, context.pepper, token);

  if (lookup.status === 'reused') {
    // A token we already rotated away has come back. The legitimate client
    // replaced it and moved on, so a copy is in circulation — and there is no
    // way to tell whether the replay or the current session is the attacker.
    //
    // So everything goes. Signing the real user out is an inconvenience;
    // leaving an attacker holding a live session is not.
    await revokeAllSessions(context.db, lookup.userId);

    // Through `record`, which cannot throw. The revocation above has already
    // happened by this point, so a failed log line would turn a correctly
    // handled token reuse into a 500 — and the caller would learn nothing about
    // whether their session survived.
    await record(context.db, context.pepper, request, lookup.userId, 'session_reuse_detected');

    // Every session has just been revoked, so the owner is about to be asked
    // for their master password on every device with no explanation. This is
    // the explanation.
    await alert(
      context.db,
      context.email,
      context.pepper,
      lookup.userId,
      'session_reuse_detected',
      request.headers.get('cf-ipcountry'),
    );

    return null;
  }

  if (lookup.status !== 'valid' || !token) {
    return null;
  }

  return { session: lookup.session, token };
}
