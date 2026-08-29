import { emailTokens } from '@core/db';
import type { Database } from '@core/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { bytesToBase64Url, randomBytes } from '@core/crypto';
import type { Bytes } from '@core/crypto';

/**
 * Tokens sent to an account's own email address.
 *
 * The rule that shapes every function here: **a token from an email never
 * opens a vault.** One clears a lockout, the other approves a sign-in from an
 * unfamiliar device, and both leave the master password exactly where it was.
 *
 * A magic link that signed somebody in would make their mailbox equivalent to
 * their vault, and every claim this product makes would quietly become a claim
 * about whoever runs their email.
 *
 * Stored as a hash, like session tokens and for the same reason: a database
 * dump must not yield working links.
 */

export type TokenPurpose = 'unlock' | 'device';

/**
 * Fifteen minutes.
 *
 * Long enough to walk to another device and read the message, short enough that
 * a link left sitting in an inbox is not a standing key. It matches the lockout
 * window, which is the thing it exists to shorten.
 */
export const TOKEN_TTL_MS = 15 * 60 * 1000;

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest) as Bytes);
}

/**
 * Mint a token and return the half that goes in the email.
 *
 * Any earlier token for the same purpose is spent first. Two live unlock links
 * for one account is one more than anybody needs, and the older one is usually
 * the one an attacker already has a copy of.
 */
export async function issueToken(
  db: Database,
  userId: string,
  purpose: TokenPurpose,
): Promise<string> {
  await spendAll(db, userId, purpose);

  const token = bytesToBase64Url(randomBytes(32));

  await db.insert(emailTokens).values({
    id: crypto.randomUUID(),
    userId,
    purpose,
    tokenHash: await hash(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  return token;
}

/**
 * Accept a token, once.
 *
 * Returns the user it belongs to, or null. Marks it used before the caller acts
 * on it, so a link clicked twice — by a mail client prefetching it, say, which
 * they do — does the thing once.
 */
export async function redeemToken(
  db: Database,
  token: string,
  purpose: TokenPurpose,
): Promise<string | null> {
  const rows = await db
    .select({ id: emailTokens.id, userId: emailTokens.userId })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.tokenHash, await hash(token)),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const found = rows[0];
  if (!found) return null;

  await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, found.id));

  return found.userId;
}

/** Spend every live token of one purpose for one account. */
export async function spendAll(db: Database, userId: string, purpose: TokenPurpose): Promise<void> {
  await db
    .update(emailTokens)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, purpose),
        isNull(emailTokens.usedAt),
      ),
    );
}
