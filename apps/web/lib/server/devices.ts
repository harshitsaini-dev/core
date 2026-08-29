import { devices } from '@core/db';
import type { Database } from '@core/db';
import { and, eq } from 'drizzle-orm';
import { bytesToBase64Url, randomBytes } from '@core/crypto';
import type { Bytes } from '@core/crypto';
import type { NextRequest } from 'next/server';

/**
 * Recognising a browser that has been here before.
 *
 * A correct master password from an unfamiliar browser is the moment worth
 * pausing on: it is what a stolen password looks like. Not the sign-in itself —
 * people buy laptops — but the first one from somewhere new.
 *
 * Recognition is by a random value this browser was given and only it has, not
 * by what it says about itself. A user agent string is shared by millions, so
 * trusting one would mean trusting anybody running the same browser version;
 * an IP address changes on the train. The cookie is the only thing here that is
 * actually about *this* device.
 *
 * Stored hashed, like session tokens and for the same reason: a database dump
 * must not yield a set of devices somebody can pretend to be.
 */

export const DEVICE_COOKIE = 'core_device';

/**
 * Two years.
 *
 * Long, on purpose. This cookie is not a credential — on its own it opens
 * nothing and proves nothing except "this browser has been verified before".
 * Expiring it early only means asking somebody for an email code again on a
 * machine they have used for a year, which teaches them to expect the prompt
 * and click through it.
 */
const DEVICE_TTL_SECONDS = 60 * 60 * 24 * 730;

async function hash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest) as Bytes);
}

/**
 * Whether this request comes from a browser this account has verified.
 *
 * Scoped to the user, so a cookie from one account is not a recognised device
 * on another — an obvious hole, and one that a lookup by token alone would
 * have.
 */
export async function isKnownDevice(
  db: Database,
  userId: string,
  request: NextRequest,
): Promise<boolean> {
  const token = request.cookies.get(DEVICE_COOKIE)?.value;
  if (!token) return false;

  const rows = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.userId, userId), eq(devices.tokenHash, await hash(token))))
    .limit(1);

  if (rows.length === 0) return false;

  // Best effort. A failed timestamp is not a reason to refuse a sign-in from a
  // device that has already been verified.
  try {
    await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, rows[0]!.id));
  } catch {
    console.warn('could not stamp a device; the sign-in is unaffected');
  }

  return true;
}

/** Remember this browser, and return the cookie value it should now hold. */
export async function rememberDevice(
  db: Database,
  userId: string,
  uaHash: string,
): Promise<string> {
  const token = bytesToBase64Url(randomBytes(32));

  await db.insert(devices).values({
    id: crypto.randomUUID(),
    userId,
    uaHash,
    tokenHash: await hash(token),
    trusted: true,
    lastSeenAt: new Date(),
  });

  return token;
}

export function deviceCookie(token: string): string {
  // `HttpOnly` because nothing in the page needs to read this, and `Lax` rather
  // than `Strict` so arriving from a link in the verification email still
  // counts as the same browser.
  return [
    `${DEVICE_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${DEVICE_TTL_SECONDS}`,
  ].join('; ');
}
