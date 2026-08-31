import { attachments, folders, itemVersions, vaultItems } from '@core/db';
import { ENVELOPE_PATTERN, TRASH_RETENTION_DAYS, unsafeAsEncrypted } from '@core/shared';
import type { SyncedFolder, SyncedItem } from '@core/shared';
import { and, asc, eq, gt, inArray, isNotNull, lt } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import type { RequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
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

const folderUpsertSchema = z.object({
  op: z.literal('folder-upsert'),
  id: z.uuid(),
  nameEnc: envelope,
  parentId: z.uuid().nullable().default(null),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .default(null),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

const folderDeleteSchema = z.object({
  op: z.literal('folder-delete'),
  id: z.uuid(),
});

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

/**
 * Gone, rather than in the trash.
 *
 * Separate from `delete` on purpose. Everything else in this file is
 * recoverable, and the trash exists because there is no password reset here and
 * an accidental delete would be the second way to lose data for good. This is
 * the one operation that removes that safety net, so it is its own verb and the
 * screen that sends it asks twice.
 *
 * Only a row already in the trash can be purged. Skipping that check would let
 * a bug — or a replayed request — take a live item straight out of the vault.
 */
const purgeSchema = z.object({
  op: z.literal('purge'),
  id: z.uuid(),
});

/**
 * The contents an edit replaced.
 *
 * Sent by the client alongside the change, because the server cannot read
 * either version and so cannot tell whether anything actually differs.
 */
const versionSchema = z.object({
  op: z.literal('version'),
  id: z.uuid(),
  itemId: z.uuid(),
  dataEnc: envelope,
});

const pushSchema = z.object({
  operations: z
    .array(
      z.discriminatedUnion('op', [
        upsertSchema,
        deleteSchema,
        restoreSchema,
        purgeSchema,
        versionSchema,
        folderUpsertSchema,
        folderDeleteSchema,
      ]),
    )
    .max(500),
});

/**
 * Two megabytes per item, five hundred items per batch.
 *
 * Generous for text, which is all this holds — attachments go to object storage
 * and never through here. The cap exists so that a bug or a hostile client
 * cannot use the vault as free storage.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Remove items and everything hanging off them.
 *
 * Order matters and the reason is storage rather than tidiness: the attachment
 * rows are read before anything is deleted, because once the row is gone the
 * object key is gone with it and the bytes in R2 become unreachable and
 * uncounted — a file nobody can see, nobody can delete, and the quota does not
 * know about.
 *
 * The objects go last. If that fails, what is left behind is storage; the other
 * order leaves rows pointing at nothing, which is a file that appears to exist
 * and cannot be opened.
 */
/**
 * Drop what has been in the trash longer than it says it keeps things.
 *
 * The trash screen has always said "deleted items stay here for 30 days" and
 * `TRASH_RETENTION_DAYS` has always been 30. Nothing read it. Items sat there
 * for as long as the account existed, which made the sentence on screen a
 * promise about privacy that the database was not keeping — somebody who
 * deleted a password in March still had its ciphertext on the server in
 * December.
 *
 * Run on the account's own sync rather than on a schedule, for the same reason
 * the share sweep is: there is no cron here. An account that never syncs never
 * sweeps, and an account that never syncs is not accumulating anything either.
 */
async function sweepTrash(
  db: RequestContext['db'],
  files: RequestContext['files'],
  userId: string,
  now: Date,
): Promise<void> {
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * 86_400_000);

  const stale = await db
    .select({ id: vaultItems.id })
    .from(vaultItems)
    .where(
      and(
        eq(vaultItems.userId, userId),
        isNotNull(vaultItems.deletedAt),
        lt(vaultItems.deletedAt, cutoff),
      ),
    );

  await purgeItems(
    db,
    files,
    userId,
    stale.map((row) => row.id),
  );
}

async function purgeItems(
  db: RequestContext['db'],
  files: RequestContext['files'],
  userId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;

  const blobs = await db
    .select({ blobKey: attachments.blobKey })
    .from(attachments)
    .where(inArray(attachments.itemId, [...ids]));

  /*
   * The children go explicitly as well as by cascade.
   *
   * Not load-bearing, and said so rather than left looking like it is: the
   * schema declares `onDelete: cascade` on both, D1 and miniflare both enforce
   * it, and deleting these two lines breaks no test — checked.
   *
   * They stay because of what the failure would look like if an environment
   * ever did not enforce it. The blob keys were read above and the objects are
   * deleted below from that list; an unenforced cascade leaves attachment rows
   * pointing at objects this function has already removed, and a quota that
   * counts files nobody can open. Silent, and only visible as a number that
   * will not go down.
   */
  await db.delete(attachments).where(inArray(attachments.itemId, [...ids]));
  await db.delete(itemVersions).where(inArray(itemVersions.itemId, [...ids]));

  await db
    .delete(vaultItems)
    .where(and(inArray(vaultItems.id, [...ids]), eq(vaultItems.userId, userId)));

  for (const blob of blobs) {
    try {
      await files.delete(blob.blobKey);
    } catch {
      // The row is already gone. A failure here leaves bytes in the bucket that
      // nothing references, which is worth neither a 500 nor abandoning the
      // rest of the batch.
    }
  }
}

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

function folderToWire(row: typeof folders.$inferSelect): SyncedFolder {
  return {
    id: row.id,
    parentId: row.parentId,
    nameEnc: row.nameEnc,
    color: row.color,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt?.getTime() ?? null,
  };
}

/**
 * How many previous versions of an item to keep.
 *
 * The same reasoning as the environment manager: every one of these is a
 * password that was live at some point, and the one somebody rotated because
 * it leaked is exactly the one they do not want kept forever.
 */
const MAX_ITEM_VERSIONS = 10;

async function pruneItemVersions(
  db: ReturnType<typeof getRequestContext>['db'],
  itemId: string,
): Promise<void> {
  const rows = await db
    .select({ id: itemVersions.id })
    .from(itemVersions)
    .where(eq(itemVersions.itemId, itemId))
    .orderBy(asc(itemVersions.createdAt));

  const excess = rows.slice(0, Math.max(0, rows.length - MAX_ITEM_VERSIONS));
  if (excess.length === 0) return;

  await db.delete(itemVersions).where(
    inArray(
      itemVersions.id,
      excess.map((row) => row.id),
    ),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  // Before any work. The decision depends only on the caller's own address, so
  // it reveals nothing about whether any account exists — which is why it can
  // sit outside the constant-time block without becoming an oracle of its own.
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

  const sinceParam = new URL(request.url).searchParams.get('since');
  const since = sinceParam === null ? 0 : Number(sinceParam);
  if (!Number.isFinite(since) || since < 0) return badRequest();

  // Folders and items share one cursor and one round trip. Two endpoints with
  // two cursors would let a client hold items pointing at folders it has not
  // pulled yet, which renders as everything sitting in "no folder".
  const [itemRows, folderRows] = await Promise.all([
    context.db
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
      ),
    context.db
      .select()
      .from(folders)
      .where(
        and(eq(folders.userId, current.session.userId), gt(folders.updatedAt, new Date(since))),
      ),
  ]);

  const items = itemRows.map(toWire);
  const folderList = folderRows.map(folderToWire);

  // The cursor is the newest updatedAt seen, not "now". Using the clock would
  // skip anything written between the query and the response.
  const cursor = [...items, ...folderList].reduce(
    (newest, row) => Math.max(newest, row.updatedAt),
    since,
  );

  return ok({ items, folders: folderList, cursor });
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

  const { db, files } = context;
  const userId = current.session.userId;
  const now = new Date();

  // Cheap, and this is the one route an active account is guaranteed to hit.
  await sweepTrash(db, files, userId, now);

  // Which of the named ids this user actually owns, per table. Everything below
  // is filtered through these, so an operation naming another user's row is
  // silently ignored rather than rejected — a rejection would confirm it exists.
  const itemIds = [
    ...new Set(
      operations
        .filter((operation) => !operation.op.startsWith('folder-'))
        // A version names the item it belongs to, not itself: its own id is
        // the new row's, which nobody owns yet.
        .map((operation) => (operation.op === 'version' ? operation.itemId : operation.id)),
    ),
  ];
  const folderIds = [
    ...new Set(
      operations
        .filter((operation) => operation.op.startsWith('folder-'))
        .map((operation) => operation.id),
    ),
  ];

  const [ownedItems, ownedFolders] = await Promise.all([
    itemIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: vaultItems.id, deletedAt: vaultItems.deletedAt })
          .from(vaultItems)
          .where(and(eq(vaultItems.userId, userId), inArray(vaultItems.id, itemIds))),
    folderIds.length === 0
      ? Promise.resolve([])
      : db
          .select({ id: folders.id })
          .from(folders)
          .where(and(eq(folders.userId, userId), inArray(folders.id, folderIds))),
  ]);

  const owned = new Set(ownedItems.map((row) => row.id));

  /*
   * Which of them are in the trash.
   *
   * A purge is only allowed against one of these. The schema comment claimed
   * this before the check existed, and a test written to hold it to that found
   * a live item being deleted outright — no trash, no undo, from a single
   * malformed or replayed request.
   */
  const trashed = new Set(ownedItems.filter((row) => row.deletedAt !== null).map((row) => row.id));

  // An item deleted earlier in this same batch counts as trashed. The client
  // queues the delete and the purge under separate keys and sends them
  // together, so reading only the stored `deletedAt` would refuse a purge for a
  // row this very request soft-deletes a few operations earlier.
  for (const operation of operations) {
    if (operation.op === 'delete') trashed.add(operation.id);
  }
  const ownedFolderIds = new Set(ownedFolders.map((row) => row.id));

  for (const operation of operations) {
    if (operation.op === 'folder-upsert') {
      const values = {
        nameEnc: unsafeAsEncrypted(operation.nameEnc),
        // A folder claiming itself as parent would make the tree unwalkable.
        // The client also guards against this; the server cannot check for
        // longer cycles, since it cannot read the names or reason about intent.
        parentId: operation.parentId === operation.id ? null : operation.parentId,
        color: operation.color,
        sortOrder: operation.sortOrder,
        updatedAt: now,
      };

      if (ownedFolderIds.has(operation.id)) {
        await db
          .update(folders)
          .set(values)
          .where(and(eq(folders.id, operation.id), eq(folders.userId, userId)));
      } else {
        await db
          .insert(folders)
          .values({ id: operation.id, userId, createdAt: now, ...values })
          .onConflictDoNothing();
      }
      continue;
    }

    if (operation.op === 'folder-delete') {
      if (!ownedFolderIds.has(operation.id)) continue;

      // Soft, like items. The items inside are not touched: the schema clears
      // their folder reference on delete, and losing a folder should never mean
      // losing what was in it.
      await db
        .update(folders)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(folders.id, operation.id), eq(folders.userId, userId)));

      await db
        .update(vaultItems)
        .set({ folderId: null, updatedAt: now })
        .where(and(eq(vaultItems.folderId, operation.id), eq(vaultItems.userId, userId)));
      continue;
    }

    if (operation.op === 'version') {
      if (!owned.has(operation.itemId)) continue;

      await db
        .insert(itemVersions)
        .values({
          id: operation.id,
          itemId: operation.itemId,
          dataEnc: unsafeAsEncrypted(operation.dataEnc),
          createdAt: now,
        })
        .onConflictDoNothing();

      await pruneItemVersions(db, operation.itemId);
      continue;
    }

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

    if (operation.op === 'purge') {
      // Silently, like every other operation here that names something the
      // caller may not touch: refusing would confirm the id is real.
      if (trashed.has(operation.id)) {
        await purgeItems(db, files, userId, [operation.id]);
      }
      continue;
    }

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
