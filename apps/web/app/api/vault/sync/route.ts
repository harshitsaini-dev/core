import { vaultItems } from '@core/db';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import type { SyncedItem } from '@core/shared';
import { and, eq, gt, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { authFailure, badRequest, ok, serverError } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * Vault synchronisation.
 *
 * `GET` pulls everything changed since a cursor. `POST` pushes a batch of
 * changes. Both deal exclusively in opaque blobs — this route has no idea what
 * an item is, and could not tell a password from a shopping list.
 *
 * Two things it does care about, because nothing else can:
 *
 *   1. **Ownership.** Every read is filtered by the session's user id and every
 *      write is conditioned on it. The client supplies item ids, so a request
 *      naming somebody else's item must change nothing rather than erroring —
 *      an error would confirm the item exists.
 *
 *   2. **Deletes are soft.** Trash is a feature, and on a product with no
 *      password reset an accidental permanent delete is unrecoverable in the
 *      same way a forgotten password is.
 */

const envelope = z
  .string()
  .regex(ENVELOPE_PATTERN, 'expected a v1 ciphertext envelope')
  .max(2_000_000);

const blindIndex = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(64);

const upsertSchema = z.object({
  op: z.literal('upsert'),
  id: z.uuid(),
  type: z.enum(['login', 'note', 'card', 'identity', 'ssh']),
  dataEnc: envelope,
  folderId: z.uuid().nullable().default(null),
  urlBlindIndex: blindIndex.nullable().default(null),
  favorite: z.boolean().default(false),
  lastUsedAt: z.number().int().nonnegative().nullable().default(null),
});

const deleteSchema = z.object({
  op: z.literal('delete'),
  id: z.uuid(),
});

const restoreSchema = z.object({
  op: z.literal('restore'),
  id: z.uuid(),
});

const pushSchema = z.object({
  operations: z.array(z.discriminatedUnion('op', [upsertSchema, deleteSchema, restoreSchema])).max(500),
});

/**
 * Two megabytes per item, five hundred items per batch.
 *
 * Generous for text, which is all this holds — attachments go to object storage
 * and never through here. The cap exists so that a bug or a hostile client
 * cannot use the vault as free storage.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function toWire(row: typeof vaultItems.$inferSelect): SyncedItem {
  return {
    id: row.id,
    type: row.type,
    dataEnc: row.dataEnc,
    folderId: row.folderId,
    urlBlindIndex: row.urlBlindIndex,
    favorite: row.favorite,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt?.getTime() ?? null,
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const sinceParam = new URL(request.url).searchParams.get('since');
  const since = sinceParam === null ? 0 : Number(sinceParam);
  if (!Number.isFinite(since) || since < 0) return badRequest();

  const rows = await context.db
    .select()
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.userId, current.session.userId),
        // Deleted rows are included deliberately: a client that pulled an item
        // before it was trashed has to be told it is gone, and a filtered query
        // would leave it holding a copy forever.
        gt(vaultItems.updatedAt, new Date(since)),
      ),
    );

  const items = rows.map(toWire);

  // The cursor is the newest updatedAt seen, not "now". Using the clock would
  // skip anything written between the query and the response.
  const cursor = items.reduce((newest, item) => Math.max(newest, item.updatedAt), since);

  return ok({ items, cursor });
}

export async function POST(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  let operations: z.infer<typeof pushSchema>['operations'];
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = pushSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return badRequest();
    operations = parsed.data.operations;
  } catch {
    return badRequest();
  }

  const { db } = context;
  const userId = current.session.userId;
  const now = new Date();

  // Which of the named ids this user actually owns. Everything below is
  // filtered through this, so an operation naming another user's item is
  // silently ignored rather than rejected — a rejection would confirm it exists.
  const ids = [...new Set(operations.map((operation) => operation.id))];
  const owned = new Set(
    ids.length === 0
      ? []
      : (
          await db
            .select({ id: vaultItems.id })
            .from(vaultItems)
            .where(and(eq(vaultItems.userId, userId), inArray(vaultItems.id, ids)))
        ).map((row) => row.id),
  );

  for (const operation of operations) {
    if (operation.op === 'upsert') {
      if (owned.has(operation.id)) {
        await db
          .update(vaultItems)
          .set({
            type: operation.type,
            dataEnc: unsafeAsEncrypted(operation.dataEnc),
            folderId: operation.folderId,
            urlBlindIndex: operation.urlBlindIndex,
            favorite: operation.favorite,
            lastUsedAt: operation.lastUsedAt === null ? null : new Date(operation.lastUsedAt),
            updatedAt: now,
          })
          .where(and(eq(vaultItems.id, operation.id), eq(vaultItems.userId, userId)));
      } else {
        // Not owned means either new, or somebody else's. Inserting with the
        // session's user id makes the second case impossible: the row lands in
        // the caller's own vault or the primary key rejects it.
        await db
          .insert(vaultItems)
          .values({
            id: operation.id,
            userId,
            type: operation.type,
            dataEnc: unsafeAsEncrypted(operation.dataEnc),
            folderId: operation.folderId,
            urlBlindIndex: operation.urlBlindIndex,
            favorite: operation.favorite,
            lastUsedAt: operation.lastUsedAt === null ? null : new Date(operation.lastUsedAt),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      }
      continue;
    }

    if (!owned.has(operation.id)) continue;

    await db
      .update(vaultItems)
      .set({
        // Soft delete. Trash matters more here than on most products: there is
        // no password reset, and an unrecoverable accidental delete would be
        // the second way to lose data permanently.
        deletedAt: operation.op === 'delete' ? now : null,
        updatedAt: now,
      })
      .where(and(eq(vaultItems.id, operation.id), eq(vaultItems.userId, userId)));
  }

  return ok({ status: 'ok', cursor: now.getTime() });
}
