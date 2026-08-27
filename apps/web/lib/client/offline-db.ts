'use client';

import type { Bytes } from '@core/crypto';
import type { SyncedFolder, SyncedItem } from '@core/shared';
import Dexie from 'dexie';
import type { Table } from 'dexie';
import type { Operation } from './vault-api';

/**
 * The offline cache.
 *
 * Everything stored here is encrypted twice. Item contents arrive already
 * encrypted under the Account Key, which no amount of local access can undo
 * without the master password. On top of that, each row is encrypted again
 * under a **device key**.
 *
 * The second layer is worth explaining, because at a glance it looks like
 * encrypting ciphertext for no reason. It protects two things the first layer
 * does not:
 *
 *   1. **Metadata.** Item ids, types, timestamps and favourite flags are
 *      plaintext on the wire — the server needs them for routing. Left
 *      unencrypted here they would tell anyone reading the browser profile how
 *      many logins exist, when they change, and which are used most.
 *
 *   2. **Exfiltration.** The device key is a non-extractable `CryptoKey`. The
 *      browser will structured-clone it into IndexedDB and hand it back, but no
 *      script can read its bytes. So an XSS can decrypt the cache only while it
 *      is running in this origin; it cannot copy the key out and take the cache
 *      with it.
 *
 * What it does not protect against is malware on the device running as the
 * user. Nothing in a browser can.
 */

const DEVICE_KEY_ID = 'device';
const CACHE_AAD = 'core.cache.v1';

interface KeyRow {
  id: string;
  key: CryptoKey;
}

interface CacheRow {
  id: string;
  /** Device-encrypted `SyncedItem`. Opaque without the device key. */
  iv: Bytes;
  blob: Bytes;
  /** Left in the clear so a delta sync can be planned without decrypting. */
  updatedAt: number;
}

interface OutboxRow {
  id: string;
  iv: Bytes;
  blob: Bytes;
  queuedAt: number;
  attempts: number;
}

interface MetaRow {
  key: string;
  value: number;
}

/** Device-encrypted material that is neither an item nor a queued change. */
interface SecretRow {
  id: string;
  iv: Bytes;
  blob: Bytes;
}

class CoreDatabase extends Dexie {
  keys!: Table<KeyRow, string>;
  cache!: Table<CacheRow, string>;
  folders!: Table<CacheRow, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<MetaRow, string>;
  secrets!: Table<SecretRow, string>;

  constructor() {
    super('core-vault');

    this.version(1).stores({
      keys: 'id',
      cache: 'id, updatedAt',
      outbox: 'id, queuedAt',
      meta: 'key',
    });

    // Adding a store rather than changing one, so an existing cache upgrades
    // in place instead of being discarded.
    this.version(2).stores({
      keys: 'id',
      cache: 'id, updatedAt',
      outbox: 'id, queuedAt',
      meta: 'key',
      secrets: 'id',
    });

    // Folders live in their own store rather than beside items. They share a
    // cursor on the wire, but mixing them here would mean every cache read
    // decrypting every folder to find out it was not an item.
    this.version(3).stores({
      keys: 'id',
      cache: 'id, updatedAt',
      folders: 'id, updatedAt',
      outbox: 'id, queuedAt',
      meta: 'key',
      secrets: 'id',
    });
  }
}

let database: CoreDatabase | undefined;

function db(): CoreDatabase {
  database ??= new CoreDatabase();
  return database;
}

/** Whether this environment can cache at all. */
export function isSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * Fetch the device key, creating it on first use.
 *
 * Generated non-extractable, so it can never leave the browser — not through
 * this code, and not through anything injected into the page.
 */
async function deviceKey(): Promise<CryptoKey> {
  const existing = await db().keys.get(DEVICE_KEY_ID);
  if (existing) return existing.key;

  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);

  await db().keys.put({ id: DEVICE_KEY_ID, key });
  return key;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function seal(value: unknown): Promise<{ iv: Bytes; blob: Bytes }> {
  const key = await deviceKey();
  const iv: Bytes = crypto.getRandomValues(new Uint8Array(12));
  const blob = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(CACHE_AAD) },
      key,
      encoder.encode(JSON.stringify(value)),
    ),
  ) as Bytes;
  return { iv, blob };
}

async function open<T>(row: { iv: Bytes; blob: Bytes }): Promise<T | null> {
  try {
    const key = await deviceKey();
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: row.iv, additionalData: encoder.encode(CACHE_AAD) },
      key,
      row.blob,
    );
    return JSON.parse(decoder.decode(plain)) as T;
  } catch {
    // A row that will not open is a row written under a key that no longer
    // exists — a cleared profile, or a partially wiped cache. It is dropped
    // rather than thrown on: the server still has it.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cached items
// ---------------------------------------------------------------------------

export async function readCache(): Promise<SyncedItem[]> {
  if (!isSupported()) return [];

  const rows = await db().cache.toArray();
  const items = await Promise.all(rows.map((row) => open<SyncedItem>(row)));
  return items.filter((item): item is SyncedItem => item !== null);
}

export async function writeCache(items: readonly SyncedItem[]): Promise<void> {
  if (!isSupported() || items.length === 0) return;

  const rows = await Promise.all(
    items.map(async (item) => ({ id: item.id, ...(await seal(item)), updatedAt: item.updatedAt })),
  );

  await db().cache.bulkPut(rows);
}

// ---------------------------------------------------------------------------
// Cached folders
// ---------------------------------------------------------------------------

export async function readFolderCache(): Promise<SyncedFolder[]> {
  if (!isSupported()) return [];

  const rows = await db().folders.toArray();
  const opened = await Promise.all(rows.map((row) => open<SyncedFolder>(row)));
  return opened.filter((folder): folder is SyncedFolder => folder !== null);
}

export async function writeFolderCache(list: readonly SyncedFolder[]): Promise<void> {
  if (!isSupported() || list.length === 0) return;

  const rows = await Promise.all(
    list.map(async (folder) => ({
      id: folder.id,
      ...(await seal(folder)),
      updatedAt: folder.updatedAt,
    })),
  );

  await db().folders.bulkPut(rows);
}

// ---------------------------------------------------------------------------
// Offline unlock
// ---------------------------------------------------------------------------

/**
 * What is needed to open the vault without a server.
 *
 * All three are things the server already hands out: the salt and parameters
 * are served to anyone who asks (that is what prelogin does), and the wrapped
 * Account Key is useless without a master password. Keeping a copy here is what
 * turns "works offline" from a claim about reading into one about opening.
 *
 * It is worth being clear about the cost, because it is real. A copy of the
 * wrapper on the device is a copy an attacker who takes the device can attack
 * offline, at their own pace, without a rate limit. That is inherent to every
 * password manager that opens without a network, and the defence is the same
 * one the server relies on: Argon2id, tuned so each guess costs real time and
 * memory. It is documented in the threat model rather than left implicit.
 */
export interface OfflineUnlock {
  readonly email: string;
  readonly kdfSalt: string;
  readonly kdfParams: unknown;
  readonly accountKeyWrapped: string;
}

export async function writeUnlockMaterial(material: OfflineUnlock): Promise<void> {
  if (!isSupported()) return;
  await db().secrets.put({ id: 'unlock', ...(await seal(material)) });
}

export async function readUnlockMaterial(): Promise<OfflineUnlock | null> {
  if (!isSupported()) return null;

  const row = await db().secrets.get('unlock');
  return row ? open<OfflineUnlock>(row) : null;
}

// ---------------------------------------------------------------------------
// The sync cursor
// ---------------------------------------------------------------------------

export async function readCursor(): Promise<number> {
  if (!isSupported()) return 0;
  return (await db().meta.get('cursor'))?.value ?? 0;
}

export async function writeCursor(value: number): Promise<void> {
  if (!isSupported()) return;
  await db().meta.put({ key: 'cursor', value });
}

// ---------------------------------------------------------------------------
// The outbox
// ---------------------------------------------------------------------------

export interface QueuedOperation {
  readonly operation: Operation;
  readonly attempts: number;
}

/**
 * Queue a change.
 *
 * Keyed by item id, so a second edit to the same item replaces the first. Only
 * the latest state matters, and sending three versions of one item spends three
 * round trips arriving where one would have.
 */
export async function enqueueOperation(operation: Operation, attempts = 0): Promise<void> {
  if (!isSupported()) return;

  await db().outbox.put({
    id: operation.id,
    ...(await seal(operation)),
    queuedAt: Date.now(),
    attempts,
  });
}

export async function readOutbox(): Promise<QueuedOperation[]> {
  if (!isSupported()) return [];

  const rows = await db().outbox.orderBy('queuedAt').toArray();
  const opened = await Promise.all(
    rows.map(async (row) => {
      const operation = await open<Operation>(row);
      return operation ? { operation, attempts: row.attempts } : null;
    }),
  );

  return opened.filter((entry): entry is QueuedOperation => entry !== null);
}

export async function clearOutbox(ids: readonly string[]): Promise<void> {
  if (!isSupported() || ids.length === 0) return;
  await db().outbox.bulkDelete([...ids]);
}

export async function recordFailure(ids: readonly string[]): Promise<void> {
  if (!isSupported()) return;

  await db().transaction('rw', db().outbox, async () => {
    for (const id of ids) {
      const row = await db().outbox.get(id);
      if (row) await db().outbox.put({ ...row, attempts: row.attempts + 1 });
    }
  });
}

// ---------------------------------------------------------------------------
// Wiping
// ---------------------------------------------------------------------------

/**
 * Destroy the cache, the queue and the device key.
 *
 * Used by the panic button. Deleting the key alone would be enough to make
 * every remaining row unopenable, but leaving the rows behind would still let
 * an observer count them, so everything goes.
 *
 * Note what this loses: anything the outbox had not yet delivered. That is the
 * correct trade for a button somebody presses because they want the data gone.
 */
export async function wipe(): Promise<void> {
  if (!isSupported()) return;

  try {
    await db().delete();
  } finally {
    database = undefined;
  }
}
