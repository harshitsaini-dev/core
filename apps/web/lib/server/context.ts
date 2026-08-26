import { getCloudflareContext } from '@opennextjs/cloudflare';
import { createDatabase } from '@core/db';
import type { Database } from '@core/db';
import type { Bytes } from '@core/crypto';
import { parsePepper } from './secrets';

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
  };
}
