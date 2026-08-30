import { attachments, vaultItems } from '@core/db';
import type { Database } from '@core/db';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Attachment ownership and quota.
 *
 * There is no `user_id` on the row: an attachment belongs to an item, and the
 * item knows whose it is. Every check here joins through that rather than
 * trusting a denormalised copy, because a copy is a thing that can disagree
 * with the truth, and the disagreement would be somebody reading somebody
 * else's file.
 */

/**
 * Fifty megabytes per account.
 *
 * R2's free tier is 10 GB, so this is not about cost. It is about a bucket
 * nobody is watching: an account is created for free here, and without a cap
 * the storage bill for this project is set by whoever signs up. Generous enough
 * for what a vault is for — recovery codes, scans, keys — and small enough that
 * a thousand accounts is still free.
 */
export const QUOTA_BYTES = 50 * 1024 * 1024;

/** Whether this user owns the item, without saying anything if they do not. */
export async function ownsItem(db: Database, userId: string, itemId: string): Promise<boolean> {
  const rows = await db
    .select({ id: vaultItems.id })
    .from(vaultItems)
    .where(and(eq(vaultItems.id, itemId), eq(vaultItems.userId, userId)))
    .limit(1);

  return rows.length > 0;
}

export async function usedBytes(db: Database, userId: string): Promise<number> {
  const rows = await db
    .select({ total: sql<number>`coalesce(sum(${attachments.size}), 0)` })
    .from(attachments)
    .innerJoin(vaultItems, eq(attachments.itemId, vaultItems.id))
    .where(eq(vaultItems.userId, userId));

  return Number(rows[0]?.total ?? 0);
}

/** An attachment row, only if this user's item owns it. */
export async function ownedAttachment(
  db: Database,
  userId: string,
  attachmentId: string,
): Promise<{ blobKey: string; itemKeyWrapped: string } | null> {
  const rows = await db
    .select({ blobKey: attachments.blobKey, itemKeyWrapped: attachments.itemKeyWrapped })
    .from(attachments)
    .innerJoin(vaultItems, eq(attachments.itemId, vaultItems.id))
    .where(and(eq(attachments.id, attachmentId), eq(vaultItems.userId, userId)))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * A random object key.
 *
 * Two random values rather than one so the bucket has a shallow prefix
 * structure, which R2 lists faster. Neither half is derived from the user, the
 * item or the filename — an object key is the one thing the storage layer sees.
 */
export function mintBlobKey(): string {
  const id = crypto.randomUUID();
  return `${id.slice(0, 2)}/${id}`;
}
