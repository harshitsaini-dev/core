import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Workspace packages ship TypeScript source, so Next has to compile them.
  transpilePackages: ['@core/crypto', '@core/db', '@core/shared', '@core/ui'],
  webpack(config) {
    // The workspace packages are written as proper ESM: their internal imports
    // carry a `.js` extension even though the files on disk are `.ts`. That is
    // correct under NodeNext resolution and required for the packages to be
    // consumable outside this bundler — but webpack resolves the literal path
    // and fails. Teaching it that `.js` may mean `.ts` keeps the packages
    // standards-correct instead of bending them to suit Next.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
  async headers() {
    return [
      {
        /*
         * Only the one header that is useful on responses the middleware skips,
         * and that middleware therefore does not set.
         *
         * Everything else lives in middleware.ts. Setting a header in both
         * places appends rather than replaces on the Workers runtime, which
         * produced `X-Frame-Options: DENY, DENY` — and neither location is
         * obviously the culprit when reading either one.
         */
        source: '/:path*',
        headers: [{ key: 'X-Content-Type-Options', value: 'nosniff' }],
      },
    ];
  },
};

export default nextConfig;

// Makes the wrangler.toml bindings (D1, KV) reachable from `next dev`.
// Without this the dev server has no database and every route that touches
// one fails only at runtime, which is the worst place to find out.
//
// `persist` is not optional here. The dev server runs with apps/web as its
// working directory, so by default Miniflare would create its own local
// database under apps/web/.wrangler — while `wrangler d1 migrations apply
// --local`, run from the repo root, writes to the root .wrangler. The result is
// two local replicas and a dev server querying the empty one, which surfaces as
// "no such table" long after the migration reported success. Pointing both at
// the root state directory keeps there being exactly one local database.
void initOpenNextCloudflareForDev({
  persist: { path: '../../.wrangler/state/v3' },
});
