import { shares } from '@core/db';
import type { Database } from '@core/db';
import { and, eq, lt, sql } from 'drizzle-orm';
import { bytesToBase64Url } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import type { Encrypted } from '@core/shared';

/**
 * One-time share links.
 *
 * The shape of the link is the whole design:
 *
 *     https://.../s/<token>#<key>
 *
 * The token goes to the server, which stores only its SHA-256 and uses that to
 * find the row — the same reasoning as the email tokens next door, so a
 * database dump does not yield working links. The key after the `#` is never
 * sent by any browser, so the server cannot decrypt what it is storing even
 * with the row and the request log side by side.
 *
 * What the server therefore knows about a share: that one exists, roughly how
 * big it is, when it was made, when it expires, and who made it. Not what is in
 * it, and not who opened it.
 */

/**
 * A day, and no option to make it longer.
 *
 * A share is a password being handed to somebody now — over a call, in a chat,
 * across a desk. Anything that is still valid next week is not that; it is a
 * second copy of the secret living somewhere with no master password in front
 * of it. The sender can always make another.
 */
export const SHARE_TTL_MS = 24 * 60 * 60 * 1000;

/** Ciphertext is base64 of an encrypted item; well past anything the UI sends. */
export const MAX_SHARE_BYTES = 64 * 1024;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest) as Bytes);
}

/** 32 random bytes, base64url. The half that goes in the link. */
export function mintToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)) as Bytes);
}

export async function createShare(
  db: Database,
  senderId: string,
  payload: string,
  now = Date.now(),
): Promise<string> {
  const token = mintToken();

  await db.insert(shares).values({
    id: crypto.randomUUID(),
    senderId,
    payloadEnc: payload as Encrypted,
    tokenBlindIndex: await hashToken(token),
    maxViews: 1,
    viewCount: 0,
    expiresAt: new Date(now + SHARE_TTL_MS),
  });

  return token;
}

export type ShareLookup =
  { readonly status: 'ready'; readonly expiresAt: number } | { readonly status: 'gone' };

/**
 * Whether a share is still there, without spending it.
 *
 * This is what a `GET` on the link does, and it is deliberately not the thing
 * that burns it. A one-time link pasted into a chat is fetched by the preview
 * bot before the recipient ever sees it — Slack, WhatsApp, iMessage all do it —
 * and a link that burns on `GET` would hand the only view to a crawler and show
 * the person it was meant for an empty page. Spending requires the `POST` below,
 * which needs a click.
 */
export async function peekShare(
  db: Database,
  token: string,
  now = Date.now(),
): Promise<ShareLookup> {
  const rows = await db
    .select({ expiresAt: shares.expiresAt, viewCount: shares.viewCount, maxViews: shares.maxViews })
    .from(shares)
    .where(eq(shares.tokenBlindIndex, await hashToken(token)))
    .limit(1);

  const row = rows[0];
  if (!row) return { status: 'gone' };
  if (row.expiresAt.getTime() <= now || row.viewCount >= row.maxViews) return { status: 'gone' };

  return { status: 'ready', expiresAt: row.expiresAt.getTime() };
}

/**
 * Spend a share and return what was in it.
 *
 * The count is incremented in the same statement that checks it, and the row is
 * only handed back if that statement matched. Reading first and writing second
 * is a race two requests a millisecond apart would win, and "one-time" that
 * turns into twice under load is not a property, it is a hope.
 */
export async function burnShare(
  db: Database,
  token: string,
  now = Date.now(),
): Promise<string | null> {
  const blind = await hashToken(token);

  const claimed = await db
    .update(shares)
    .set({ viewCount: sql`${shares.viewCount} + 1` })
    .where(
      and(
        eq(shares.tokenBlindIndex, blind),
        lt(shares.viewCount, shares.maxViews),
        sql`${shares.expiresAt} > ${now}`,
      ),
    )
    .returning({ payload: shares.payloadEnc });

  const row = claimed[0];
  if (!row) return null;

  // Gone from the table, not merely marked spent. A row that stays behind is a
  // ciphertext somebody can still steal, and its only remaining purpose is to
  // say that a share once existed.
  await db.delete(shares).where(eq(shares.tokenBlindIndex, blind));

  return row.payload;
}

/**
 * Drop what has expired.
 *
 * Run on the sender's own requests rather than on a schedule: there is no cron
 * here, and an expired share is only a problem for as long as its ciphertext
 * sits in the table.
 */
export async function sweepExpired(db: Database, now = Date.now()): Promise<void> {
  await db.delete(shares).where(sql`${shares.expiresAt} <= ${now}`);
}
