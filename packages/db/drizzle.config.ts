import { defineConfig } from 'drizzle-kit';

/**
 * Migrations are generated here and applied by Wrangler:
 *
 *   pnpm db:generate                    # diff the schema, write SQL
 *   pnpm db:migrate:local               # apply to the local D1 replica
 *   pnpm db:migrate                     # apply to production
 *
 * drizzle-kit only ever generates the SQL. Applying it is Wrangler's job, so
 * that the migration history D1 tracks stays the single source of truth.
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'd1-http',
  schema: './src/schema.ts',
  out: './migrations',
  verbose: true,
  strict: true,
});
