import { attachments } from '@core/db';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';
import { QUOTA_BYTES, mintBlobKey, ownsItem, usedBytes } from '@/lib/server/attachments';

/**
 * Files attached to a vault item.
 *
 * `GET` lists what an item has, with the wrapped key and the encrypted name —
 * everything needed to render a list, and nothing that would open one. The
 * bodies stay in R2 until somebody asks.
 *
 * `POST` takes an already-encrypted body and stores it. What arrives here is a
 * ciphertext under a key this process has never seen, so the checks it can make
 * are the only ones it makes: is this your item, and is there room.
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

  // An empty list rather than a rejection, like the history route: a 404 would
  // confirm that somebody else's item id is a real one.
  if (!(await ownsItem(context.db, current.session.userId, itemId))) {
    return ok({ attachments: [], used: 0, quota: QUOTA_BYTES });
  }

  const rows = await context.db
    .select({
      id: attachments.id,
      itemKeyWrapped: attachments.itemKeyWrapped,
      filenameEnc: attachments.filenameEnc,
      mimeEnc: attachments.mimeEnc,
      size: attachments.size,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(eq(attachments.itemId, itemId));

  return ok({
    attachments: rows.map((row) => ({ ...row, createdAt: row.createdAt.getTime() })),
    used: await usedBytes(context.db, current.session.userId),
    quota: QUOTA_BYTES,
  });
}

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
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return badRequest();
  }

  const itemId = form.get('itemId');
  const body = form.get('body');
  const itemKeyWrapped = form.get('itemKeyWrapped');
  const filenameEnc = form.get('filenameEnc');
  const mimeEnc = form.get('mimeEnc');

  if (
    typeof itemId !== 'string' ||
    typeof itemKeyWrapped !== 'string' ||
    typeof filenameEnc !== 'string' ||
    typeof mimeEnc !== 'string' ||
    !(body instanceof Blob)
  ) {
    return badRequest();
  }

  if (!(await ownsItem(context.db, current.session.userId, itemId))) return authFailure();

  const size = body.size;
  if (size === 0) return badRequest();

  // Measured here rather than trusted from the client, because the number the
  // client sends is the number an attacker controls and the quota is the only
  // thing standing between a free account and this project's storage bill.
  const used = await usedBytes(context.db, current.session.userId);
  if (used + size > QUOTA_BYTES) {
    // 200 with an outcome rather than a status code, because the quota is a
    // thing the screen has to explain — "413" arriving at a file picker is not
    // an explanation of anything.
    return ok({ error: 'quota', used, quota: QUOTA_BYTES });
  }

  const blobKey = mintBlobKey();
  await context.files.put(blobKey, await body.arrayBuffer());

  try {
    const id = crypto.randomUUID();
    await context.db.insert(attachments).values({
      id,
      itemId,
      blobKey,
      itemKeyWrapped: itemKeyWrapped as never,
      filenameEnc: filenameEnc as never,
      mimeEnc: mimeEnc as never,
      size,
    });

    return ok({ id });
  } catch (cause) {
    // The object landed and the row did not. Left alone, that is a byte nobody
    // can reach and nobody is counting — it would sit in the bucket forever,
    // outside the quota, invisible to every listing.
    await context.files.delete(blobKey);
    throw cause;
  }
}
