/**
 * @core/db
 *
 * Drizzle schema and the D1 client.
 *
 * Every column holding user data is typed `Encrypted` — a branded string only
 * `@core/crypto` can produce. Writing plaintext into the vault is a compile
 * error, not a code-review question.
 */

export * from './schema.js';
export * from './client.js';
