import { defineCloudflareConfig } from '@opennextjs/cloudflare';

/**
 * OpenNext adapter configuration.
 *
 * Its job here is narrow: make Next.js run on the Workers runtime, and make the
 * D1 and KV bindings from wrangler.toml available during `next dev` as well as
 * in production. Without it, local development has no database and the auth
 * routes cannot be exercised at all.
 */
export default defineCloudflareConfig();
