import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createDatabase } from '@core/db';
import type { Database } from '@core/db';
import type { Bytes } from '@core/crypto';
import type { EmailConfig } from './email';
import { parsePepper } from './secrets';
import type { TurnstileConfig } from './turnstile';

/**
 * Access to the Cloudflare bindings declared in wrangler.toml.
 *
 * In production these come from the Worker. In development they come from the
 * same file via the OpenNext adapter, so a route behaves identically in both —
 * which matters here, because "works locally, fails in production" on an auth
 * endpoint is not a bug you want to discover from users.
 */

export interface RequestContext {
  readonly db: Database;
  readonly kv: KVNamespace;
  readonly pepper: Bytes;
  /**
   * Whether the rate limiter should take its caller identity from a header.
   *
   * Set in `.dev.vars` and in the CI workflows, and nowhere else. See the note
   * on `callerAddress` for why it has to exist at all.
   */
  readonly rateLimitTestMode: boolean;
  /**
   * How to send email, if this instance can.
   *
   * Optional by design. An instance without it is a working instance with three
   * notifications switched off, not a broken one — which is the right default
   * for something anybody can self-host in fifteen minutes.
   */
  readonly email: EmailConfig;
  /**
   * Bot protection, if this instance has it.
   *
   * Also optional. The rate limiter and the account lockout are there either
   * way; this is for the case neither sees — a thousand addresses making three
   * requests each.
   */
  readonly turnstile: TurnstileConfig;
}

/**
 * Build the per-request context.
 *
 * Throws if the pepper is missing or malformed. That is deliberate: an instance
 * running without a pepper would silently store verifiers that a database leak
 * could attack offline, so refusing to start is the correct failure.
 */
export function getRequestContext(): RequestContext {
  const { env } = getCloudflareContext();

  return {
    db: createDatabase(env.DB),
    kv: env.RATE_LIMIT,
    pepper: parsePepper(env.AUTH_PEPPER),
    rateLimitTestMode: env.RATE_LIMIT_TEST_MODE === '1',
    email: { apiKey: env.RESEND_API_KEY, from: env.RESEND_FROM_EMAIL },
    turnstile: { secretKey: env.TURNSTILE_SECRET_KEY },
  };
}
