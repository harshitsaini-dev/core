/**
 * Bridges the two type sources for Cloudflare bindings.
 *
 * `Cloudflare.Env` is generated from wrangler.toml by `pnpm cf types`, so it is
 * always in step with the actual bindings. `CloudflareEnv` is the interface
 * @opennextjs/cloudflare expects callers to augment. Declaring one to extend
 * the other means adding a binding to wrangler.toml and regenerating is the
 * only step needed — there is no second list to keep in sync by hand.
 */
declare global {
  interface CloudflareEnv extends Cloudflare.Env {}
}

export {};
