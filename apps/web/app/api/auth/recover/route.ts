import { auditLog, users } from '@core/db';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqual,
  deriveAuthVerifier,
} from '@core/crypto';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { authFailure, badRequest, serverError } from '@/lib/server/responses';
import { emailIndex, hashIp, hashUserAgent } from '@/lib/server/secrets';
import { issueSession, revokeAllSessions, sessionCookie } from '@/lib/server/session';
import { constantTime } from '@/lib/server/timing';

/**
 * POST /api/auth/recover
 *
 * Replaces the master password using the Emergency Kit.
 *
 * The awkward part of recovery is that the server has to permit it while being
 * unable to perform it. It cannot check the recovery key itself — that key
 * decrypts the entire vault, and receiving it would end the zero-knowledge
 * property outright. So the client sends a *verifier* derived from it, which
 * proves possession and decrypts nothing.
 *
 * Everything else arrives already done. The browser has decrypted the Account
 * Key with the recovery key and re-wrapped it under a Master Key derived from
 * the new password; this route swaps four opaque strings and gets out of the
 * way. It never sees either password, and it cannot read the vault before or
 * after.
 */

const base64Url = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url');

const recoverSchema = z.object({
  email: z.string().min(3).max(320),
  /** Proof that the caller holds the Account Key. */
  recoveryVerifier: base64Url.max(128),

  /** The new credentials, all derived in the browser. */
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
    .max(4096)
    .transform(unsafeAsEncrypted),
});

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof recoverSchema>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = recoverSchema.safeParse(JSON.parse(raw));
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

  const { db, pepper } = context;

  const { value: recoveredUserId } = await constantTime(async (): Promise<string | null> => {
    const index = await emailIndex(pepper, input.email);

    const rows = await db
      .select({ id: users.id, recoveryVerifier: users.recoveryVerifier })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];

    // Computed either way, so an unknown address is not measurably cheaper to
    // reject than a wrong recovery key.
    const submitted = await deriveAuthVerifier(base64UrlToBytes(input.recoveryVerifier), pepper);

    // A null stored verifier means the account predates recovery. It cannot be
    // back-filled — only somebody holding the Account Key could compute it — so
    // those accounts have no recovery path. Saying so here would identify them,
    // so they fail exactly like any other mismatch.
    if (!row?.recoveryVerifier) {
      constantTimeEqual(submitted, submitted.slice().fill(0));
      return null;
    }

    if (!constantTimeEqual(submitted, base64UrlToBytes(row.recoveryVerifier))) {
      return null;
    }

    const newAuthVerifier = await deriveAuthVerifier(base64UrlToBytes(input.authKey), pepper);

    await db
      .update(users)
      .set({
        authVerifier: bytesToBase64Url(newAuthVerifier),
        kdfSalt: input.kdfSalt,
        kdfParams: JSON.stringify(input.kdfParams),
        accountKeyWrapped: input.accountKeyWrapped,
        failedAttempts: 0,
        lockedUntil: null,
      })
      .where(eq(users.id, row.id));

    // Anyone signed in under the old password is signed out. A recovery is
    // either the owner locking an intruder out or an intruder locking the owner
    // out, and under both readings the existing sessions should not survive it.
    await revokeAllSessions(db, row.id);

    return row.id;
  });

  if (!recoveredUserId) {
    return authFailure();
  }

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    userId: recoveredUserId,
    event: 'password_changed',
    ipHash: await hashIp(pepper, request.headers.get('cf-connecting-ip') ?? 'unknown'),
    uaHash: await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown'),
    geoCountry: request.headers.get('cf-ipcountry'),
  });

  // Issued after the mass revocation above, so this caller is the only one left
  // holding a session.
  //
  // Signing them in here rather than sending them back to the login form is not
  // a shortcut: they have just proved possession of the Account Key, which is
  // strictly stronger evidence than the password they would be asked to type,
  // and they set that password moments ago. Demanding it again would add
  // friction without adding proof.
  const issued = await issueSession(db, pepper, recoveredUserId);

  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Set-Cookie': sessionCookie(issued),
    },
  });
}
