import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { deviceCookie, rememberDevice } from '@/lib/server/devices';
import { redeemCode } from '@/lib/server/email-tokens';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, serverError, tooManyRequests } from '@/lib/server/responses';
import { emailIndex, hashUserAgent } from '@/lib/server/secrets';
import { issueSession, sessionCookie } from '@/lib/server/session';

/**
 * Finish a sign-in from a browser this account has not used before.
 *
 * Reachable only after the login route accepted a master password and answered
 * `verify` — the code it emailed exists nowhere else, and is created nowhere
 * else. So this endpoint is not a way in; it is the second half of one that has
 * already been passed.
 *
 * **The code does not open the vault, and cannot.** It releases a session and
 * remembers the browser. The wrapped keys still come back only to a caller who
 * proved the password, and they still only open in a browser that can derive
 * the Master Key. A mailbox is not a second way in — that is the claim, and
 * this is where it would break if it were going to.
 *
 * Three wrong codes and the code is spent. Six digits is a million
 * possibilities and a guess costs nothing but a request; the attempt limit is
 * what makes a number short enough to type acceptable at all.
 */

const schema = z.object({
  email: z.string().min(3).max(320),
  code: z.string().regex(/^[0-9]{6}$/, 'expected six digits'),
});

export async function POST(request: NextRequest): Promise<Response> {
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

  let input: z.infer<typeof schema>;
  try {
    input = schema.parse(await request.json());
  } catch {
    return badRequest();
  }

  const { db, pepper } = context;

  const rows = await db
    .select({
      id: users.id,
      accountKeyWrapped: users.accountKeyWrapped,
      publicKey: users.publicKey,
      privateKeyWrapped: users.privateKeyWrapped,
    })
    .from(users)
    .where(eq(users.emailBlindIndex, await emailIndex(pepper, input.email)))
    .limit(1);

  const row = rows[0];

  // The same refusal for an unknown address and a wrong code. A different
  // answer here would say whether the address is real, which is what every
  // other route on this path refuses to say.
  if (!row) return authFailure();

  const attempt = await redeemCode(db, row.id, input.code);
  if (!attempt.ok) return authFailure();

  const token = await rememberDevice(
    db,
    row.id,
    await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown'),
  );

  await record(db, pepper, request, row.id, 'device_trusted');

  const issued = await issueSession(db, pepper, row.id);

  const headers = new Headers({
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
  });

  // Two cookies: the session, and the one that stops this browser being asked
  // again. Appended rather than set, because a second `Set-Cookie` assigned
  // through the object form replaces the first rather than joining it.
  headers.append('Set-Cookie', sessionCookie(issued));
  headers.append('Set-Cookie', deviceCookie(token));

  return new Response(
    JSON.stringify({
      status: 'ok',
      accountKeyWrapped: row.accountKeyWrapped,
      publicKey: row.publicKey,
      privateKeyWrapped: row.privateKeyWrapped,
    }),
    { status: 200, headers },
  );
}
