import { attachments } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';
import { ownedAttachment } from '@/lib/server/attachments';

/**
 * One attachment's bytes, or its removal.
 *
 * Both go through the same ownership join: an attachment belongs to an item and
 * the item knows whose it is. A route that looked the row up by id alone would
 * serve any file to anybody who guessed a UUID.
 *
 * What comes back is still ciphertext. The key that opens it was wrapped by the
 * Account Key and is handed over in the listing, so this response is useless to
 * anything that intercepted it.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await params;
  const row = await ownedAttachment(context.db, current.session.userId, id);
  if (!row) return authFailure();

  const object = await context.files.get(row.blobKey);
  if (!object) return serverError();

  return new Response(object.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // Never cached. The bytes are encrypted, but a shared cache holding a
      // response keyed by a session cookie is a class of bug worth not having.
      'cache-control': 'no-store',
    },
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
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

  const { id } = await params;
  const row = await ownedAttachment(context.db, current.session.userId, id);
  if (!row) return authFailure();

  // The row first. If the object delete fails afterwards the file is
  // unreachable and uncounted, which is a leak of storage; the other order
  // leaves a row pointing at nothing, which is a leak of a file that appears to
  // exist and cannot be opened.
  await context.db.delete(attachments).where(eq(attachments.id, id));
  await context.files.delete(row.blobKey);

  return ok({ deleted: true });
}
