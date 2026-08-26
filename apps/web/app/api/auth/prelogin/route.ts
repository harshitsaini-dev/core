import type { KdfParams } from '@core/shared';
import { users } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { badRequest, ok, serverError } from '@/lib/server/responses';
import { decoyKdfParams, decoySalt, emailIndex } from '@/lib/server/secrets';
import { constantTime } from '@/lib/server/timing';

// No `runtime = 'edge'` here. Under the OpenNext adapter the entire app already
// runs on workerd, and opting a route into Next's edge runtime instead cuts it
// off from the Cloudflare bindings it needs.

/**
 * POST /api/auth/prelogin
 *
 * Returns the KDF salt and parameters a client needs before it can derive keys
 * from a master password. It is unauthenticated by necessity — the client
 * cannot prove anything until after it has derived its keys.
 *
 * That makes this the single most enumeration-prone endpoint in the product.
 * An attacker with a list of email addresses will point it here first, so two
 * properties matter more than anything else:
 *
 *   1. **A response for an unknown address is indistinguishable from a real
 *      one.** Both the salt and the KDF parameters are derived deterministically
 *      from the address under a server key, so they look random, stay stable
 *      across repeat queries, and cannot be recognised as fake without the
 *      pepper. Two ways this goes wrong if done casually: random bytes make
 *      enumeration trivial (ask twice, compare), and returning the *default*
 *      parameters for unknown addresses is just as bad, because real accounts
 *      carry values calibrated on the device that created them and therefore
 *      rarely match the defaults exactly.
 *
 *   2. **The response takes the same time either way.** A real lookup returns a
 *      row and a fake one does not, and no amount of careful branching makes
 *      those cost the same. So the handler is padded to a fixed budget instead.
 *
 * Returning a salt for an address that does not exist is not a leak. A salt is
 * public by design — it is served to anyone before authentication regardless.
 */

const preloginSchema = z.object({
  email: z.string().min(3).max(320),
});

interface PreloginResponse {
  readonly kdfSalt: string;
  readonly kdfParams: KdfParams;
}

function parseKdfParams(raw: string): KdfParams {
  const parsed: unknown = JSON.parse(raw);
  // Stored by us at signup, so a failure here is corruption, not user input.
  return parsed as KdfParams;
}

export async function POST(request: NextRequest): Promise<Response> {
  let email: string;
  try {
    const body: unknown = await request.json();
    const parsed = preloginSchema.safeParse(body);
    if (!parsed.success) {
      // Rejected before any timing-sensitive work: a malformed body reveals
      // nothing about whether any particular account exists.
      return badRequest();
    }
    email = parsed.data.email;
  } catch {
    return badRequest();
  }

  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const { value, overran } = await constantTime(async (): Promise<PreloginResponse> => {
    const { db, pepper } = context;

    // Both branches are computed every time. The decoy is not "the fallback" —
    // it is always produced, so that the presence of a row changes only which
    // value is selected, never which work is done.
    const [index, decoy, decoyParams] = await Promise.all([
      emailIndex(pepper, email),
      decoySalt(pepper, email),
      decoyKdfParams(pepper, email),
    ]);

    const rows = await db
      .select({ kdfSalt: users.kdfSalt, kdfParams: users.kdfParams })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    const row = rows[0];

    return {
      kdfSalt: row?.kdfSalt ?? decoy,
      kdfParams: row ? parseKdfParams(row.kdfParams) : decoyParams,
    };
  });

  if (overran && process.env.NODE_ENV !== 'development') {
    // The padding stopped hiding anything: either the database got slow or the
    // budget is set too low. Both are worth knowing about in production.
    //
    // Suppressed in development on purpose. There, the D1 binding is reached
    // through an IPC proxy that costs well over the budget on its own, so this
    // would fire on every single request — and a warning that always fires is a
    // warning nobody reads by the time it matters.
    console.warn('prelogin exceeded its constant-time budget');
  }

  return ok(value);
}
