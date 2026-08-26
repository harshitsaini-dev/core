import { drizzle } from 'drizzle-orm/d1';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from './schema.js';

export type Database = DrizzleD1Database<typeof schema>;

/**
 * Wrap a D1 binding in Drizzle.
 *
 * Called per request. Workers have no connection pool to reuse and no process
 * that outlives the request, so there is nothing to cache here.
 */
export function createDatabase(binding: D1Database): Database {
  return drizzle(binding, { schema, logger: false });
}
