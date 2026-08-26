import { auditLog, users } from '@core/db';
import { base64UrlToBytes, bytesToBase64Url, constantTimeEqual, deriveAuthVerifier } from '@core/crypto';
import { eq, sql } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { authFailure, badRequest, serverError } from '@/lib/server/responses';
import { emailIndex, hashIp, hashUserAgent } from '@/lib/server/secrets';
import { issueSession, sessionCookie } from '@/lib/server/session';
import { constantTime } from '@/lib/server/timing';

/**
 * POST /api/auth/login
 *
 * Verifies the Auth Key the client derived from its master password, and issues
 * a session.
 *
 * What this route can and cannot do is worth being precise about. It proves the
 * caller knows the master password, and it hands back the wrapped keys. It does
 * **not** unlock anything: those keys are encrypted under a Master Key that only
 * the browser can derive, so the server hands over material it cannot itself
 * use. A stolen session lets an attacker fetch and destroy ciphertext — bad, and
 * why sessions are revocable — but not read it.
 */

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  authKey: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url'),
});

const MAX_BODY_BYTES = 2 * 1024;

interface LoginOutcome {
  readonly ok: boolean;
  readonly userId?: string;
  readonly keys?: {
    accountKeyWrapped: string;
    publicKey: string;
    privateKeyWrapped: string;
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  let input: z.infer<typeof loginSchema>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = loginSchema.safeParse(JSON.parse(raw));
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

  const { value: outcome } = await constantTime(async (): Promise<LoginOutcome> => {
    const index = await emailIndex(pepper, input.email);

    const rows = await db
      .select({
        id: users.id,
        authVerifier: users.authVerifier,
        accountKeyWrapped: users.accountKeyWrapped,
        publicKey: users.publicKey,
        privateKeyWrapped: users.privateKeyWrapped,
      })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];

    // Computed whether or not a row was found. Skipping the HMAC for unknown
    // addresses would make "no such user" measurably cheaper than "wrong
    // password", which is precisely the distinction this must not expose.
    const submitted = await deriveAuthVerifier(base64UrlToBytes(input.authKey), pepper);
    const submittedEncoded = bytesToBase64Url(submitted);

    if (!row) {
      // Compare against a value that cannot match, so the comparison itself
      // still happens and still costs the same.
      constantTimeEqual(submitted, submitted.slice().fill(0));
      return { ok: false };
    }

    const matches = constantTimeEqual(
      base64UrlToBytes(submittedEncoded),
      base64UrlToBytes(row.authVerifier),
    );

    if (!matches) {
      // Recorded, not yet enforced. Lockout needs the magic-link unlock path to
      // exist first, or a wrong password three times would strand a real user
      // with no way back in. Enforcement lands with the rest of the rate
      // limiting in Phase 5 (RL-06).
      await db
        .update(users)
        .set({ failedAttempts: sql`${users.failedAttempts} + 1` })
        .where(eq(users.id, row.id));

      return { ok: false, userId: row.id };
    }

    await db.update(users).set({ failedAttempts: 0 }).where(eq(users.id, row.id));

    return {
      ok: true,
      userId: row.id,
      keys: {
        accountKeyWrapped: row.accountKeyWrapped,
        publicKey: row.publicKey,
        privateKeyWrapped: row.privateKeyWrapped,
      },
    };
  });

  const ipHash = await hashIp(pepper, request.headers.get('cf-connecting-ip') ?? 'unknown');
  const uaHash = await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown');
  const geoCountry = request.headers.get('cf-ipcountry');

  if (outcome.userId) {
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId: outcome.userId,
      event: outcome.ok ? 'login' : 'login_failed',
      ipHash,
      uaHash,
      geoCountry,
    });
  }

  if (!outcome.ok || !outcome.userId || !outcome.keys) {
    // One response for an unknown address and for a wrong password. Anything
    // else turns login into the enumeration oracle prelogin avoids being.
    return authFailure();
  }

  const issued = await issueSession(db, pepper, outcome.userId);

  return new Response(JSON.stringify({ status: 'ok', ...outcome.keys }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Set-Cookie': sessionCookie(issued),
    },
  });
}
