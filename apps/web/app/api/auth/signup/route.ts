import { auditLog, users } from '@core/db';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import { base64UrlToBytes, deriveAuthVerifier, bytesToBase64Url } from '@core/crypto';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { badRequest, ok, serverError } from '@/lib/server/responses';
import { emailEncrypt, emailIndex, hashIp, hashUserAgent } from '@/lib/server/secrets';
import { constantTime } from '@/lib/server/timing';

/**
 * POST /api/auth/signup
 *
 * Creates an account. Note what the request body does **not** contain: the
 * master password, or anything derived from it that could decrypt the vault.
 *
 * All of the real work happens in the browser before this route is called. The
 * client derives its keys, generates a random Account Key, wraps it, generates
 * a sharing key pair, and sends only the results. This handler is little more
 * than a place to put opaque strings, and that is exactly how it should read —
 * if it ever needs to understand what it is storing, the design has broken.
 *
 * The one exception is the email address, which arrives in the clear because
 * the server has to be able to send to it. See `emailEncrypt`.
 */

const base64Url = z
  .string()
  .min(1)
  .regex(/^[A-Za-z0-9_-]+$/, 'expected base64url');

/**
 * A client-supplied ciphertext envelope.
 *
 * The transform is where an untrusted string becomes an `Encrypted`. The server
 * can only ever check the structure — the contents are opaque to it by design —
 * so this is the honest place to draw that line, and the only place in the app
 * allowed to draw it.
 */
const envelope = z
  .string()
  .regex(ENVELOPE_PATTERN, 'expected a v1 ciphertext envelope')
  .max(4096)
  .transform(unsafeAsEncrypted);

const signupSchema = z.object({
  email: z.email().max(320),

  /** Derived client-side from the master password. Never the password itself. */
  authKey: base64Url.max(128),

  /** Public. The client must send back what prelogin will later serve. */
  kdfSalt: base64Url.max(64),
  kdfParams: z.object({
    algorithm: z.literal('argon2id'),
    memoryKiB: z.number().int().min(8192).max(1_048_576),
    iterations: z.number().int().min(1).max(64),
    parallelism: z.number().int().min(1).max(16),
  }),

  /** The Account Key, encrypted under the client's Master Key. */
  accountKeyWrapped: envelope,

  /** ECDH P-256, for sharing. Public half in the clear. */
  publicKey: base64Url.max(512),
  privateKeyWrapped: envelope,

  /**
   * Proves possession of the Account Key during recovery. Derived client-side
   * from the recovery key; it decrypts nothing on its own.
   */
  recoveryVerifier: base64Url.max(128),
});

/** Bodies are small and fully specified; anything larger is not a real client. */
const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: NextRequest): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (declaredLength > MAX_BODY_BYTES) {
    return badRequest();
  }

  let input: z.infer<typeof signupSchema>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = signupSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return badRequest();
    input = parsed.data;
  } catch {
    return badRequest();
  }

  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const { db, pepper } = context;

  const { value } = await constantTime(async () => {
    const [index, emailEnc] = await Promise.all([
      emailIndex(pepper, input.email),
      emailEncrypt(pepper, input.email),
    ]);

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.emailBlindIndex, index))
      .limit(1);

    // Both branches still compute the verifier, so that an address already in
    // use does not answer measurably faster than a fresh one.
    const [verifier, recoveryVerifier] = await Promise.all([
      deriveAuthVerifier(base64UrlToBytes(input.authKey), pepper),
      // Peppered the same way, for the same reason: a database dump alone must
      // not let anyone mount the recovery flow offline.
      deriveAuthVerifier(base64UrlToBytes(input.recoveryVerifier), pepper),
    ]);

    if (existing.length > 0) {
      // Deliberately reported as success. Telling the caller "that address is
      // taken" turns signup into the enumeration oracle that prelogin was
      // carefully built to avoid being. A real owner of the address finds out
      // via email; nobody else learns anything.
      return { created: false };
    }

    const id = crypto.randomUUID();
    await db.insert(users).values({
      id,
      emailBlindIndex: index,
      emailEnc,
      authVerifier: bytesToBase64Url(verifier),
      kdfSalt: input.kdfSalt,
      kdfParams: JSON.stringify(input.kdfParams),
      accountKeyWrapped: input.accountKeyWrapped,
      publicKey: input.publicKey,
      privateKeyWrapped: input.privateKeyWrapped,
      recoveryVerifier: bytesToBase64Url(recoveryVerifier),
    });

    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      userId: id,
      event: 'signup',
      ipHash: await hashIp(pepper, request.headers.get('cf-connecting-ip') ?? 'unknown'),
      uaHash: await hashUserAgent(pepper, request.headers.get('user-agent') ?? 'unknown'),
      geoCountry: request.headers.get('cf-ipcountry'),
    });

    return { created: true };
  });

  // The response is identical either way, for the reason above.
  void value;
  return ok({ status: 'ok' });
}
