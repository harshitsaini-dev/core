import type { Encrypted } from '@core/shared';
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * The Core database schema.
 *
 * Reading rule for this file: **any column that could tell an operator
 * something about a user is typed `Encrypted`.** That is a branded string only
 * `@core/crypto` can produce, so a route handler cannot write plaintext into
 * one — it will not compile.
 *
 * What the server is allowed to know, and nothing more:
 *   - that a row exists, and which user owns it
 *   - when it was created, changed or deleted
 *   - its type (login / note / card), for client-side filtering after sync
 *   - opaque blind-index tags, for equality lookups it cannot invert
 *
 * What it must never know: titles, usernames, passwords, URLs, folder names,
 * project names, `.env` keys, `.env` values, notes, card numbers.
 */

/** A ciphertext column. */
const encrypted = (name: string) => text(name).$type<Encrypted>();

/** Unix milliseconds. SQLite has no date type worth using. */
const timestamp = (name: string) => integer(name, { mode: 'timestamp_ms' });

const createdAt = () =>
  timestamp('created_at')
    .notNull()
    .$defaultFn(() => new Date());

const updatedAt = () =>
  timestamp('updated_at')
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdateFn(() => new Date());

// ---------------------------------------------------------------------------
// Users and keys
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),

    /**
     * HMAC of the normalised email under a server-held key, so login can find
     * the row. The address itself is stored encrypted beside it.
     *
     * Note the asymmetry with every other blind index in this schema: those are
     * keyed by the user's Account Key, which the server never has. This one
     * cannot be, because it must be computable *before* the user is identified.
     * The server therefore does learn whether two signups used the same address
     * — which is unavoidable if duplicate accounts are to be prevented at all.
     */
    emailBlindIndex: text('email_blind_index').notNull(),
    emailEnc: encrypted('email_enc').notNull(),

    /** `HMAC-SHA256(pepper, authKey)`. See ADR-012. */
    authVerifier: text('auth_verifier').notNull(),

    /** Public. Served by /api/auth/prelogin before authentication. */
    kdfSalt: text('kdf_salt').notNull(),
    /** Per-user Argon2id parameters, as JSON. Raised over time, never lowered. */
    kdfParams: text('kdf_params').notNull(),

    /** The Account Key, encrypted under the Master Key. The heart of the vault. */
    accountKeyWrapped: encrypted('account_key_wrapped').notNull(),

    /** ECDH P-256. Public half in the clear, private half wrapped. */
    publicKey: text('public_key').notNull(),
    privateKeyWrapped: encrypted('private_key_wrapped').notNull(),

    /** Set once the user confirms they have stored their Emergency Kit. */
    emergencyKitAcknowledgedAt: timestamp('emergency_kit_acknowledged_at'),

    /** Populated by the lockout logic. Reset on a successful login. */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [uniqueIndex('users_email_blind_index_idx').on(table.emailBlindIndex)],
);

// ---------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------

export const folders = sqliteTable(
  'folders',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Self-reference for nesting. Depth is enforced client-side. */
    parentId: text('parent_id'),

    nameEnc: encrypted('name_enc').notNull(),
    /** Not encrypted: a colour swatch reveals nothing and drives the UI. */
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('folders_user_idx').on(table.userId)],
);

export const vaultItems = sqliteTable(
  'vault_items',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    folderId: text('folder_id').references(() => folders.id, { onDelete: 'set null' }),

    /**
     * Left in the clear so the client can filter by type without decrypting
     * every row first. It leaks only the shape of a vault, never its contents.
     */
    type: text('type', { enum: ['login', 'note', 'card', 'identity', 'ssh'] }).notNull(),

    /**
     * The entire item as one encrypted JSON blob: title, username, password,
     * URL, custom fields, TOTP secret, recovery codes, notes.
     *
     * One blob rather than a column per field, deliberately. Separate columns
     * would leak which optional fields a user filled in, and would make partial
     * decryption failures possible.
     */
    dataEnc: encrypted('data_enc').notNull(),

    /** Host-level tag, for duplicate detection. Client-derived, server-opaque. */
    urlBlindIndex: text('url_blind_index'),

    favorite: integer('favorite', { mode: 'boolean' }).notNull().default(false),
    lastUsedAt: timestamp('last_used_at'),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
    /** Soft delete. Purged after 30 days by a scheduled job. */
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [
    index('vault_items_user_idx').on(table.userId),
    // Drives delta sync: "everything this user changed since my cursor".
    index('vault_items_sync_idx').on(table.userId, table.updatedAt),
    index('vault_items_folder_idx').on(table.folderId),
    index('vault_items_url_idx').on(table.userId, table.urlBlindIndex),
  ],
);

export const itemVersions = sqliteTable(
  'item_versions',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    dataEnc: encrypted('data_enc').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('item_versions_item_idx').on(table.itemId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Developer environments
// ---------------------------------------------------------------------------

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nameEnc: encrypted('name_enc').notNull(),
    color: text('color'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('projects_user_idx').on(table.userId)],
);

export const environments = sqliteTable(
  'environments',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** "development", "staging", "production" — encrypted like everything else. */
    nameEnc: encrypted('name_enc').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index('environments_project_idx').on(table.projectId)],
);

export const envVars = sqliteTable(
  'env_vars',
  {
    id: text('id').primaryKey(),
    environmentId: text('environment_id')
      .notNull()
      .references(() => environments.id, { onDelete: 'cascade' }),

    /**
     * The key is encrypted too. `STRIPE_SECRET_KEY` in the clear would tell an
     * operator what a project integrates with, which is exactly the kind of
     * metadata this design refuses to leak.
     */
    keyEnc: encrypted('key_enc').notNull(),
    valueEnc: encrypted('value_enc').notNull(),
    noteEnc: encrypted('note_enc'),

    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => [index('env_vars_environment_idx').on(table.environmentId)],
);

export const envVarVersions = sqliteTable(
  'env_var_versions',
  {
    id: text('id').primaryKey(),
    envVarId: text('env_var_id')
      .notNull()
      .references(() => envVars.id, { onDelete: 'cascade' }),
    keyEnc: encrypted('key_enc').notNull(),
    valueEnc: encrypted('value_enc').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('env_var_versions_var_idx').on(table.envVarId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Attachments (R2 metadata only; the blob itself lives in object storage)
// ---------------------------------------------------------------------------

export const attachments = sqliteTable(
  'attachments',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id')
      .notNull()
      .references(() => vaultItems.id, { onDelete: 'cascade' }),
    /** Opaque R2 object key. Random, never derived from the filename. */
    blobKey: text('blob_key').notNull(),
    /** Per-attachment key, wrapped by the Account Key. */
    itemKeyWrapped: encrypted('item_key_wrapped').notNull(),
    /** Filename and MIME type are user data, so both are encrypted. */
    filenameEnc: encrypted('filename_enc').notNull(),
    mimeEnc: encrypted('mime_enc').notNull(),
    /** Size is visible — R2 billing makes hiding it pointless. */
    size: integer('size').notNull(),
    createdAt: createdAt(),
  },
  (table) => [index('attachments_item_idx').on(table.itemId)],
);

// ---------------------------------------------------------------------------
// Sessions, devices, audit
// ---------------------------------------------------------------------------

export const devices = sqliteTable(
  'devices',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** User-chosen label ("work laptop"), encrypted. */
    labelEnc: encrypted('label_enc'),
    /** Hashed, not stored raw — a user agent string is a fingerprint. */
    uaHash: text('ua_hash').notNull(),
    trusted: integer('trusted', { mode: 'boolean' }).notNull().default(false),
    firstSeenAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at'),
  },
  (table) => [index('devices_user_idx').on(table.userId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').references(() => devices.id, { onDelete: 'set null' }),

    /**
     * SHA-256 of the refresh token, never the token itself. A database dump
     * must not yield usable sessions.
     */
    tokenHash: text('token_hash').notNull(),
    /** Rotation chain. Reuse of a rotated token revokes the whole chain. */
    previousTokenHash: text('previous_token_hash'),

    expiresAt: timestamp('expires_at').notNull(),
    revokedAt: timestamp('revoked_at'),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_idx').on(table.userId),
  ],
);

export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    event: text('event', {
      enum: [
        'signup',
        'login',
        'login_failed',
        'logout',
        'unlock',
        'password_changed',
        'device_trusted',
        'session_revoked',
        'session_reuse_detected',
        'export',
        'account_locked',
      ],
    }).notNull(),
    /**
     * Hashed with a server-side key rather than stored raw. The user can still
     * see "a login from an unfamiliar place" via the country field, without the
     * database becoming a log of everywhere they have ever been.
     */
    ipHash: text('ip_hash'),
    geoCountry: text('geo_country'),
    uaHash: text('ua_hash'),
    createdAt: createdAt(),
  },
  (table) => [index('audit_log_user_idx').on(table.userId, table.createdAt)],
);

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export const shares = sqliteTable(
  'shares',
  {
    id: text('id').primaryKey(),
    senderId: text('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Encrypted to the recipient's public key, or to a link-derived key. */
    payloadEnc: encrypted('payload_enc').notNull(),
    /** Blind index of the link token, so the server can find without reading. */
    tokenBlindIndex: text('token_blind_index').notNull(),
    maxViews: integer('max_views').notNull().default(1),
    viewCount: integer('view_count').notNull().default(0),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: createdAt(),
  },
  (table) => [uniqueIndex('shares_token_idx').on(table.tokenBlindIndex)],
);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Folder = typeof folders.$inferSelect;
export type NewFolder = typeof folders.$inferInsert;
export type VaultItem = typeof vaultItems.$inferSelect;
export type NewVaultItem = typeof vaultItems.$inferInsert;
export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type Environment = typeof environments.$inferSelect;
export type EnvVar = typeof envVars.$inferSelect;
export type NewEnvVar = typeof envVars.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Device = typeof devices.$inferSelect;
export type AuditEvent = typeof auditLog.$inferSelect;
export type Share = typeof shares.$inferSelect;
