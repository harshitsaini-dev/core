import { users } from '@core/db';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import { base64UrlToBytes, deriveAuthVerifier, bytesToBase64Url } from '@core/crypto';
import { eq } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { record } from '@/lib/server/audit';
import { getRequestContext } from '@/lib/server/context';
import { verifyTurnstile } from '@/lib/server/turnstile';
import { checkLimit } from '@/lib/server/rate-limit';
import {
  badRequest,
  botCheckFailed,
  ok,
  serverError,
  tooManyRequests,
} from '@/lib/server/responses';
import { emailEnabled } from '@/lib/server/email';
import { emailEncrypt, emailIndex } from '@/lib/server/secrets';
import {
  SIGNUP_TEST_HEADER,
  redeemSignupCode,
  verificationRequired,
} from '@/lib/server/signup-codes';
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

  /**
   * The six digits sent to that address by `signup/start`.
   *
   * Optional in the schema and required in the handler, and only when this
   * instance can send mail. A self-hosted instance with no mail provider has no
   * way to deliver a code, and refusing every signup there would be a working
   * instance nobody can create an account on.
   */
  code: z
    .string()
    .regex(/^[0-9]{6}$/)
    .optional(),

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

  // Before any work. The decision depends only on the caller's own address, so
  // it reveals nothing about whether any account exists — which is why it can
  // sit outside the constant-time block without becoming an oracle of its own.
  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'signup',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  // After the limiter, before anything expensive. A refused token should cost
  // this server one HTTP call, not an Argon2id verification.
  if (!(await verifyTurnstile(context.turnstile, request))) return botCheckFailed();

  const { db, pepper } = context;

  const { value } = await constantTime(async () => {
    const [index, emailEnc] = await Promise.all([
      emailIndex(pepper, input.email),
      emailEncrypt(pepper, input.email),
    ]);

    /*
     * The address has to be proved before an account is written for it.
     *
     * Without this a vault could be created on any well-formed address at all.
     * Two things follow, and the second is worse than the first: somebody takes
     * an address they do not own, and — because this route reports success
     * either way to avoid becoming an enumeration oracle — the real owner is
     * never told, and simply finds their own address unavailable with no
     * explanation.
     *
     * The failure is reported as `created: false`, the same answer an address
     * that is already taken gets. A caller who never asked for a code learns
     * nothing they could not have worked out, and a caller guessing codes
     * learns nothing about whether the address was real.
     */
    const required = verificationRequired(
      emailEnabled(context.email),
      context.signupCodeTestMode,
      request.headers.get(SIGNUP_TEST_HEADER),
    );

    if (required) {
      if (!input.code) return { created: false };
      if (!(await redeemSignupCode(db, index, input.code))) return { created: false };
    }

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

    // Through `record`, which cannot throw. The account row is already written
    // at this point, so a failed log line would have reported a created account
    // as a failed signup — and the retry would then collide on the address.
    await record(db, pepper, request, id, 'signup');

    return { created: true };
  });

  // The response is identical either way, for the reason above.
  void value;
  return ok({ status: 'ok' });
}
