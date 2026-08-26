import { sessions } from '@core/db';
import type { Database } from '@core/db';
import { bytesToBase64Url, constantTimeEqual, randomBytes, utf8ToBytes } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { deriveServerKey } from './secrets';

/**
 * Session handling.
 *
 * A session grants API access. It does **not** unlock the vault — the keys for
 * that never leave the browser and are re-derived from the master password on
 * every unlock. So a stolen session token lets an attacker fetch and destroy
 * ciphertext, which is bad, but not read it.
 *
 * The token itself is never stored. What goes in the database is an HMAC of it
 * under a server key, so a database dump yields no usable sessions.
 */

export const SESSION_COOKIE = 'core_session';

/** Absolute lifetime. Rotation extends a session; it does not renew it forever. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rotate once a session is more than half-spent. */
const ROTATE_AFTER_MS = SESSION_TTL_MS / 2;

export interface IssuedSession {
  /** Goes to the client in a cookie. Never persisted anywhere. */
  readonly token: string;
  readonly expiresAt: Date;
}

async function hashToken(pepper: Bytes, token: string): Promise<string> {
  const key = await deriveServerKey(pepper, 'sessionToken');
  // Full 256 bits here, unlike the truncated blind indexes: this value is what
  // stands between a database reader and a working session.
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8ToBytes(token))));
}

/** Create a session for a user. */
export async function issueSession(
  db: Database,
  pepper: Bytes,
  userId: string,
  options: { deviceId?: string; previousTokenHash?: string } = {},
): Promise<IssuedSession> {
  const token = bytesToBase64Url(randomBytes(32));
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await db.insert(sessions).values({
    id: crypto.randomUUID(),
    userId,
    deviceId: options.deviceId ?? null,
    tokenHash: await hashToken(pepper, token),
    previousTokenHash: options.previousTokenHash ?? null,
    expiresAt,
  });

  return { token, expiresAt };
}

export interface ResolvedSession {
  readonly id: string;
  readonly userId: string;
  readonly expiresAt: Date;
  /** True once the session is past half its life and should be rotated. */
  readonly shouldRotate: boolean;
}

/**
 * Resolve a token to a live session, or null.
 *
 * Returns null for absent, unknown, expired and revoked tokens alike. The caller
 * has no way to tell those apart, and should not: an attacker probing with
 * guessed tokens learns nothing from the distinction.
 */
export async function resolveSession(
  db: Database,
  pepper: Bytes,
  token: string | undefined,
): Promise<ResolvedSession | null> {
  if (!token) return null;

  const tokenHash = await hashToken(pepper, token);

  const rows = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      expiresAt: sessions.expiresAt,
      tokenHash: sessions.tokenHash,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenHash), isNull(sessions.revokedAt)))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  // The lookup above already matched on equality, so this is belt-and-braces
  // against a future change that widens the query.
  if (!constantTimeEqual(utf8ToBytes(row.tokenHash), utf8ToBytes(tokenHash))) {
    return null;
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return {
    id: row.id,
    userId: row.userId,
    expiresAt: row.expiresAt,
    shouldRotate: row.expiresAt.getTime() - Date.now() < ROTATE_AFTER_MS,
  };
}

/** Revoke one session. */
export async function revokeSession(db: Database, sessionId: string): Promise<void> {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** Revoke every session a user has. Used by logout-everywhere and on password change. */
export async function revokeAllSessions(db: Database, userId: string): Promise<void> {
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}

/**
 * Rotate a session: issue a replacement and revoke the old one.
 *
 * The new row records the hash it replaced. That trail is what makes reuse
 * detectable later — a request arriving with an already-rotated token means the
 * token was captured, and the honest response is to revoke the whole chain
 * rather than quietly issue another one.
 */
export async function rotateSession(
  db: Database,
  pepper: Bytes,
  current: ResolvedSession,
  currentToken: string,
): Promise<IssuedSession> {
  const issued = await issueSession(db, pepper, current.userId, {
    previousTokenHash: await hashToken(pepper, currentToken),
  });
  await revokeSession(db, current.id);
  return issued;
}

/** The Set-Cookie value for an issued session. */
export function sessionCookie(issued: IssuedSession): string {
  const parts = [
    `${SESSION_COOKIE}=${issued.token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Expires=${issued.expiresAt.toUTCString()}`,
  ];

  // Secure would make the cookie invisible to a plain-HTTP localhost dev server,
  // which would break local development entirely. Production is HTTPS-only and
  // HSTS-enforced, so it is always set there.
  if (process.env.NODE_ENV !== 'development') {
    parts.push('Secure');
  }

  return parts.join('; ');
}

/** A Set-Cookie value that clears the session. */
export function clearedSessionCookie(): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (process.env.NODE_ENV !== 'development') {
    parts.push('Secure');
  }
  return parts.join('; ');
}
