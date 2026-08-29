import { emailTokens } from '@core/db';
import type { Database } from '@core/db';
import { and, eq, gt, isNull } from 'drizzle-orm';
import {
  bytesToBase64Url,
  constantTimeEqual,
  randomBytes,
  randomInt,
  utf8ToBytes,
} from '@core/crypto';
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
 * Wrong codes before a device code is destroyed.
 *
 * Only the six-digit codes need this. A link carries 32 random bytes and
 * nobody guesses those; a code somebody types is a code somebody can try, and
 * a million possibilities is not many when the only cost of a guess is another
 * request. Three is enough for a typo and not enough for an attack, and the
 * way back is cheap: enter the master password again and a new code is sent.
 */
export const CODE_ATTEMPT_LIMIT = 3;

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

  /*
   * Two shapes, for two jobs.
   *
   * A link is 32 random bytes because nobody has to read it — it is clicked.
   * A device code is six digits because somebody has to copy it out of an
   * email and into a form, and a value that is unpleasant to type is a value
   * people paste from the wrong place. What makes six digits acceptable is the
   * attempt limit above, not the length.
   */
  const token =
    purpose === 'device'
      ? String(randomInt(1_000_000)).padStart(6, '0')
      : bytesToBase64Url(randomBytes(32));

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
    .select({ id: emailTokens.id, userId: emailTokens.userId, attempts: emailTokens.attempts })
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

/**
 * Accept a device code, counting the wrong ones.
 *
 * Looked up by account rather than by hash, which is the difference that makes
 * the attempt limit possible at all: a wrong code hashes to nothing and matches
 * no row, so there would be nothing to count against. The row is found first,
 * then the code is compared to it.
 *
 * Returns whether it was right, and how many tries remain. On the last wrong
 * one the code is spent, so a guesser has to make somebody type their master
 * password again to get another.
 */
export async function redeemCode(
  db: Database,
  userId: string,
  code: string,
): Promise<{ ok: boolean; remaining: number }> {
  const rows = await db
    .select({
      id: emailTokens.id,
      tokenHash: emailTokens.tokenHash,
      attempts: emailTokens.attempts,
    })
    .from(emailTokens)
    .where(
      and(
        eq(emailTokens.userId, userId),
        eq(emailTokens.purpose, 'device'),
        isNull(emailTokens.usedAt),
        gt(emailTokens.expiresAt, new Date()),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return { ok: false, remaining: 0 };

  // Compared in constant time. The code is short and an attacker holding one
  // guess should not learn how much of it was right from how long the answer
  // took.
  const submitted = await hash(code);
  if (constantTimeEqual(utf8ToBytes(submitted), utf8ToBytes(row.tokenHash))) {
    await db.update(emailTokens).set({ usedAt: new Date() }).where(eq(emailTokens.id, row.id));
    return { ok: true, remaining: CODE_ATTEMPT_LIMIT };
  }

  const used = row.attempts + 1;
  const remaining = CODE_ATTEMPT_LIMIT - used;

  await db
    .update(emailTokens)
    .set(remaining > 0 ? { attempts: used } : { attempts: used, usedAt: new Date() })
    .where(eq(emailTokens.id, row.id));

  return { ok: false, remaining: Math.max(0, remaining) };
}
