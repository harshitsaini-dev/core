import { itemVersions, vaultItems } from '@core/db';
import { and, desc, eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * The previous contents of one vault item.
 *
 * Separate from sync, like the environment manager's history and for the same
 * reason: every old version is a password that was live at some point, and a
 * vault of three hundred items would otherwise ship three thousand blobs on
 * every refresh that it will almost certainly never show.
 *
 * Simpler to scope than the ENV one — a vault item carries the user it belongs
 * to, so the check is a single condition rather than a walk.
 */
export async function GET(request: NextRequest): Promise<Response> {
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
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const itemId = new URL(request.url).searchParams.get('itemId');
  if (!itemId) return badRequest();

  const { db } = context;

  const owned = await db
    .select({ id: vaultItems.id })
    .from(vaultItems)
    .where(and(eq(vaultItems.id, itemId), eq(vaultItems.userId, current.session.userId)))
    .limit(1);

  // An empty answer rather than a rejection: a 404 here would confirm that
  // somebody else's item id is a real one.
  if (owned.length === 0) return ok({ versions: [] });

  const rows = await db
    .select()
    .from(itemVersions)
    .where(eq(itemVersions.itemId, itemId))
    .orderBy(desc(itemVersions.createdAt));

  return ok({
    versions: rows.map((row) => ({
      id: row.id,
      dataEnc: row.dataEnc,
      createdAt: row.createdAt.getTime(),
    })),
  });
}
