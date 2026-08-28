import { auditLog } from '@core/db';
import type { NextRequest } from 'next/server';
import type { Bytes } from '@core/crypto';
import { hashIp, hashUserAgent } from './secrets';

/**
 * Writing to the audit log.
 *
 * An audit entry describes what happened. It does not decide it, and the whole
 * point of this file is that the code cannot forget that.
 *
 * Every one of these writes used to be a bare `await db.insert(...)` on the
 * path of the request it was recording, and on the login route that had a name:
 * the insert only ran when a user row had been found, so a write that threw
 * answered 500 for an address that exists and 401 for one that does not. That
 * is the enumeration oracle the rest of the login path is arranged around — the
 * constant-time comparison, the HMAC computed for unknown addresses, the single
 * shared failure response — rebuilt out of a logging call four lines below the
 * comment explaining why the lockout counter had to be guarded against exactly
 * this.
 *
 * The others were less dramatic and still wrong: a password change that had
 * already committed, or a recovery that had already succeeded, reported as a
 * failure because a log line could not be written.
 *
 * So there is one way to write an audit entry and it swallows its own failures.
 * A missing log line is a real loss and it is smaller than any of the above.
 */

type Event = typeof auditLog.$inferInsert.event;

/** Minimal shape needed here, so this does not depend on the full context type. */
interface Db {
  insert: (table: typeof auditLog) => {
    values: (row: typeof auditLog.$inferInsert) => Promise<unknown>;
  };
}

/**
 * Record an event, and never let the recording change the answer.
 *
 * The IP and user agent are hashed with the server-side pepper rather than
 * stored: the user can still be shown "a sign-in from an unfamiliar country"
 * without the database becoming a log of everywhere they have been.
 */
export async function record(
  db: Db,
  pepper: Bytes,
  request: NextRequest,
  userId: string,
  event: Event,
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId,
      event,
      ipHash: await hashIp(pepper, request.headers.get('cf-connecting-ip') ?? 'unknown'),
      uaHash: await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown'),
      geoCountry: request.headers.get('cf-ipcountry'),
    });
  } catch {
    // Deliberately silent to the caller. Logged for an operator, who is the
    // only one who can act on it.
    console.warn(`audit write failed for ${event}; the request itself is unaffected`);
  }
}
