import { auditLog } from '@core/db';
import type { NextRequest } from 'next/server';
import type { RequestContext } from './context';
import { hashIp, hashUserAgent } from './secrets';
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

    await context.db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId: lookup.userId,
      event: 'session_reuse_detected',
      ipHash: await hashIp(context.pepper, request.headers.get('cf-connecting-ip') ?? 'unknown'),
      uaHash: await hashUserAgent(context.pepper, request.headers.get('user-agent') ?? 'unknown'),
      geoCountry: request.headers.get('cf-ipcountry'),
    });

    return null;
  }

  if (lookup.status !== 'valid' || !token) {
    return null;
  }

  return { session: lookup.session, token };
}
