import { getTableColumns, getTableName } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

/**
 * The plaintext allowlist.
 *
 * Core's entire guarantee rests on the claim that the database holds no
 * readable user data. That claim is easy to state and easy to break — one
 * `text('title')` added in a hurry and the vault leaks metadata forever, with
 * no test failing to say so.
 *
 * So every column that is *not* ciphertext has to be listed here by hand.
 * Adding a plaintext column without a matching entry fails the test, which
 * turns "did anyone think about this?" from a code-review hope into a build
 * error.
 *
 * Only add to this list if you can say why the value tells an operator nothing
 * about the user. Write that reason next to it.
 */
const PLAINTEXT_ALLOWED: Record<string, readonly string[]> = {
  users: [
    'id',
    // HMAC under a server key. Necessary: login has to find the row before the
    // user is authenticated, so this one cannot be keyed by the Account Key.
    'email_blind_index',
    // HMAC(pepper, authKey). Not reversible to the password.
    'auth_verifier',
    // Public by design — served before authentication so the client can derive.
    'kdf_salt',
    'kdf_params',
    // ECDH public half. Public is the entire point of a public key.
    'public_key',
    // HMAC of an HKDF output. Proves possession of the Account Key; decrypts
    // nothing, and cannot be reversed into the key it was derived from.
    'recovery_verifier',
    'emergency_kit_acknowledged_at',
    // Lockout state. Server-owned; the client has no say in it.
    'failed_attempts',
    'locked_until',
    'created_at',
    'updated_at',
  ],
  folders: [
    'id',
    'user_id',
    'parent_id',
    'color',
    'sort_order',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  vault_items: [
    'id',
    'user_id',
    'folder_id',
    // Leaks the shape of a vault (how many logins vs notes), never contents.
    // Needed so the client can filter without decrypting every row.
    'type',
    // Client-derived HMAC of the host. Server-opaque.
    'url_blind_index',
    'favorite',
    'last_used_at',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  item_versions: ['id', 'item_id', 'created_at'],
  projects: ['id', 'user_id', 'color', 'created_at', 'updated_at', 'deleted_at'],
  environments: ['id', 'project_id', 'sort_order', 'created_at', 'updated_at'],
  env_vars: ['id', 'environment_id', 'sort_order', 'created_at', 'updated_at', 'deleted_at'],
  env_var_versions: ['id', 'env_var_id', 'created_at'],
  attachments: [
    'id',
    'item_id',
    // Random object key, never derived from the filename.
    'blob_key',
    // Visible because R2 bills on it; hiding it would be theatre.
    'size',
    'created_at',
  ],
  devices: [
    'id',
    'user_id',
    // Hashed, because a user agent string is a fingerprint.
    'ua_hash',
    'trusted',
    'created_at',
    'last_seen_at',
  ],
  sessions: [
    'id',
    'user_id',
    'device_id',
    // SHA-256 of the token. A dump must not yield usable sessions.
    'token_hash',
    'previous_token_hash',
    'expires_at',
    'revoked_at',
    'created_at',
  ],
  audit_log: ['id', 'user_id', 'event', 'ip_hash', 'geo_country', 'ua_hash', 'created_at'],
  shares: [
    'id',
    'sender_id',
    'token_blind_index',
    'max_views',
    'view_count',
    'expires_at',
    'created_at',
  ],
};

/**
 * Columns holding ciphertext, by naming convention.
 *
 * `_enc` for encrypted user data, `_wrapped` for a key encrypted under another
 * key. Both are `Encrypted` in the schema; the two suffixes exist so that a
 * reader can tell at a glance whether a column holds data or key material.
 */
const isEncryptedColumn = (name: string): boolean =>
  name.endsWith('_enc') || name.endsWith('_wrapped');

// Widened to unknown first: the module exports functions and types alongside
// the tables, so the union of its values is not a supertype of SQLiteTable.
const tables = (Object.values(schema) as unknown[]).filter(
  (value): value is SQLiteTable =>
    typeof value === 'object' && value !== null && Symbol.for('drizzle:Name') in value,
);

describe('schema shape', () => {
  it('exposes every table the architecture document describes', () => {
    expect(tables.map(getTableName).sort()).toEqual(Object.keys(PLAINTEXT_ALLOWED).sort());
  });
});

describe('no unreviewed plaintext', () => {
  it.each(tables.map((table) => [getTableName(table), table] as const))(
    '%s stores nothing readable that has not been justified',
    (tableName, table) => {
      const allowed = PLAINTEXT_ALLOWED[tableName] ?? [];

      const unreviewed = Object.values(getTableColumns(table))
        .map((column) => column.name)
        .filter((name) => !isEncryptedColumn(name) && !allowed.includes(name));

      expect(unreviewed).toEqual([]);
    },
  );

  it('never lists an encrypted column as plaintext', () => {
    for (const [tableName, columns] of Object.entries(PLAINTEXT_ALLOWED)) {
      const mistaken = columns.filter(isEncryptedColumn);
      expect(mistaken, `${tableName} allowlist contains ciphertext columns`).toEqual([]);
    }
  });

  it('has no stale allowlist entries for columns that no longer exist', () => {
    // A leftover entry is harmless today but silently pre-approves a future
    // column that happens to reuse the name.
    for (const table of tables) {
      const tableName = getTableName(table);
      const actual = Object.values(getTableColumns(table)).map((column) => column.name);
      const stale = (PLAINTEXT_ALLOWED[tableName] ?? []).filter((name) => !actual.includes(name));
      expect(stale, `${tableName} has stale allowlist entries`).toEqual([]);
    }
  });
});

describe('sensitive fields are actually encrypted', () => {
  // Named explicitly rather than derived, so that renaming a column to dodge
  // the `_enc` convention shows up as a failure.
  const MUST_BE_ENCRYPTED: Record<string, readonly string[]> = {
    users: ['email_enc', 'account_key_wrapped', 'private_key_wrapped'],
    folders: ['name_enc'],
    vault_items: ['data_enc'],
    item_versions: ['data_enc'],
    projects: ['name_enc'],
    environments: ['name_enc'],
    env_vars: ['key_enc', 'value_enc'],
    env_var_versions: ['key_enc', 'value_enc'],
    attachments: ['item_key_wrapped', 'filename_enc', 'mime_enc'],
    shares: ['payload_enc'],
  };

  it.each(Object.entries(MUST_BE_ENCRYPTED))(
    '%s keeps its sensitive columns',
    (tableName, expected) => {
      const table = tables.find((candidate) => getTableName(candidate) === tableName);
      expect(table, `${tableName} is missing from the schema`).toBeDefined();

      const actual = Object.values(getTableColumns(table as SQLiteTable)).map(
        (column) => column.name,
      );
      for (const column of expected) {
        expect(actual).toContain(column);
      }
    },
  );
});
