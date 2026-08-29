import { users } from '@core/db';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  deriveAuthVerifier,
} from '@core/crypto';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { alert } from '@/lib/server/alerts';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, serverError, tooManyRequests } from '@/lib/server/responses';
import { issueSession, revokeAllSessions, sessionCookie } from '@/lib/server/session';
import { requireSession } from '@/lib/server/session-guard';
import { constantTime } from '@/lib/server/timing';

/**
 * POST /api/auth/password
 *
 * Changes the master password.
 *
 * This is the operation the whole Account Key indirection exists for, and from
 * the server's side it is four opaque strings changing. The vault is encrypted
 * under the Account Key, which does not change; the Account Key is wrapped
 * under a Master Key derived from the password, and that wrapper is thirty-two
 * bytes. A vault of ten thousand items costs exactly as much to re-key as an
 * empty one.
 *
 * Everything arrives already done. The browser derived both Master Keys,
 * unwrapped with the old one and re-wrapped under the new one. This route sees
 * neither password and cannot read the vault before or after.
 *
 * The old Auth Key is required as well as a session. A session cookie proves
 * the tab was left unlocked; it does not prove the person at the keyboard knows
 * the password, and changing the password is exactly the thing an attacker who
 * found an unlocked laptop would want to do — it would lock the owner out of
 * their own vault permanently.
 */

const base64Url = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url');

const changeSchema = z.object({
  /** Proof that the caller knows the *current* password, not just that a tab is open. */
  currentAuthKey: base64Url.max(128),

  authKey: base64Url.max(128),
  kdfSalt: base64Url.max(64),
  kdfParams: z.object({
    algorithm: z.literal('argon2id'),
    memoryKiB: z.number().int().min(8192).max(1_048_576),
    iterations: z.number().int().min(1).max(64),
    parallelism: z.number().int().min(1).max(16),
  }),
  /** The same Account Key, re-wrapped under the new Master Key. */
  accountKeyWrapped: z
    .string()
    .regex(ENVELOPE_PATTERN, 'expected a v1 ciphertext envelope')
    .max(4096),
});

export async function POST(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof changeSchema>;
  try {
    const parsed = changeSchema.safeParse(await request.json());
    if (!parsed.success) return badRequest();
    input = parsed.data;
  } catch {
    return badRequest();
  }

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
    'login',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const { db, pepper } = context;
  const userId = current.session.userId;

  const { value: changed } = await constantTime(async (): Promise<boolean> => {
    const rows = await db
      .select({ authVerifier: users.authVerifier })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const row = rows[0];
    if (!row) return false;

    const submitted = await deriveAuthVerifier(base64UrlToBytes(input.currentAuthKey), pepper);

    if (
      !constantTimeEqual(
        base64UrlToBytes(bytesToBase64Url(submitted)),
        base64UrlToBytes(row.authVerifier),
      )
    ) {
      return false;
    }

    const verifier = await deriveAuthVerifier(base64UrlToBytes(input.authKey), pepper);

    await db
      .update(users)
      .set({
        authVerifier: bytesToBase64Url(verifier),
        kdfSalt: input.kdfSalt,
        kdfParams: JSON.stringify(input.kdfParams),
        accountKeyWrapped: unsafeAsEncrypted(input.accountKeyWrapped),
        // A password change is also the thing somebody does after a scare, so
        // the counters that could still lock them out are cleared.
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, userId));

    return true;
  });

  // Through `record`, which cannot throw. As a bare insert this ran after the
  // change had already committed, so a failed log line reported a password
  // change as a failure when it had succeeded.
  await record(db, pepper, request, userId, changed ? 'password_changed' : 'login_failed');

  if (changed) {
    await alert(
      db,
      context.email,
      pepper,
      userId,
      'password_changed',
      request.headers.get('cf-ipcountry'),
    );
  }

  if (!changed) return authFailure();

  /*
   * Every session goes, including this one, and a new one is issued.
   *
   * The reason to change a password is usually that somebody else might know
   * it. Leaving other sessions alive would change the lock and hand the old
   * keys back — and a session that outlived the password it was created under
   * is exactly what an attacker would want left behind.
   */
  await revokeAllSessions(db, userId);
  const issued = await issueSession(db, pepper, userId);

  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Set-Cookie': sessionCookie(issued),
    },
  });
}
