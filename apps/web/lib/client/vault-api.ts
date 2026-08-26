import { blindIndexUrl, decryptJson, encryptJson } from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import { vaultItemDataSchema } from '@core/shared';
import type { DecryptedItem, SyncedItem, VaultItemData } from '@core/shared';

/**
 * Reading and writing the vault.
 *
 * Everything here works in both directions across one boundary: plaintext on
 * this side, ciphertext on the other. Nothing that crosses it is readable, and
 * nothing readable crosses it.
 *
 * The one subtlety is `urlBlindIndex`. It is derived from the item's URL under
 * a key the server never has, and it exists so duplicate detection can happen
 * server-side without the server learning which sites a user has accounts on.
 * It is sent only for logins, because it is the only type where the value means
 * anything.
 */

interface SyncResponse {
  items: SyncedItem[];
  cursor: number;
}

export interface PullResult {
  readonly items: DecryptedItem[];
  /**
   * The rows exactly as the server sent them.
   *
   * Returned alongside the decrypted view so the caller can write them straight
   * to the offline cache. Re-encrypting the decrypted form would produce
   * different ciphertext for the same item and defeat any later comparison.
   */
  readonly raw: SyncedItem[];
  /** Items the server sent that this client could not decrypt. */
  readonly undecryptable: string[];
  readonly cursor: number;
}

async function decryptItem(keys: AccountKeys, row: SyncedItem): Promise<DecryptedItem | null> {
  try {
    const raw = await decryptJson<unknown>(keys.dataKey, row.dataEnc);
    const parsed = vaultItemDataSchema.safeParse(raw);
    if (!parsed.success) return null;

    return {
      id: row.id,
      folderId: row.folderId,
      favorite: row.favorite,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
      lastUsedAt: row.lastUsedAt,
      data: parsed.data,
    };
  } catch {
    return null;
  }
}

/**
 * Pull everything changed since `cursor`.
 *
 * An item that fails to decrypt is reported rather than thrown on. One
 * corrupted row should not make an entire vault unopenable, and the ids are
 * surfaced so the UI can say which items are affected instead of silently
 * showing a shorter list than the user remembers.
 */
export async function pull(keys: AccountKeys, cursor = 0): Promise<PullResult> {
  const response = await fetch(`/api/vault/sync?since=${cursor}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) {
    throw new Error('Could not reach the vault.');
  }

  const body = (await response.json()) as SyncResponse;

  const decrypted = await Promise.all(body.items.map((row) => decryptItem(keys, row)));

  const items: DecryptedItem[] = [];
  const undecryptable: string[] = [];

  decrypted.forEach((item, index) => {
    if (item) {
      items.push(item);
    } else {
      undecryptable.push(body.items[index]?.id ?? 'unknown');
    }
  });

  return { items, raw: body.items, undecryptable, cursor: body.cursor };
}

/**
 * Decrypt rows that came from the offline cache rather than the network.
 *
 * Same work as a pull, minus the fetch — which is the entire point: a vault
 * opened on a train should look exactly like one opened online.
 */
export async function decryptCached(
  keys: AccountKeys,
  rows: readonly SyncedItem[],
): Promise<{ items: DecryptedItem[]; undecryptable: string[] }> {
  const decrypted = await Promise.all(rows.map((row) => decryptItem(keys, row)));

  const items: DecryptedItem[] = [];
  const undecryptable: string[] = [];

  decrypted.forEach((item, index) => {
    if (item) {
      items.push(item);
    } else {
      undecryptable.push(rows[index]?.id ?? 'unknown');
    }
  });

  return { items, undecryptable };
}

/**
 * Build the wire form of a locally-created item, so it can be cached before it
 * has ever reached the server.
 */
export function operationToSynced(operation: Operation, existing?: SyncedItem): SyncedItem | null {
  if (operation.op !== 'upsert') {
    if (!existing) return null;
    return {
      ...existing,
      deletedAt: operation.op === 'delete' ? Date.now() : null,
      updatedAt: Date.now(),
    };
  }

  const now = Date.now();
  return {
    id: operation.id,
    type: operation.type,
    dataEnc: operation.dataEnc,
    folderId: operation.folderId,
    urlBlindIndex: operation.urlBlindIndex,
    favorite: operation.favorite,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
    lastUsedAt: operation.lastUsedAt,
  };
}

export type Operation =
  | {
      op: 'upsert';
      id: string;
      type: VaultItemData['type'];
      dataEnc: string;
      folderId: string | null;
      urlBlindIndex: string | null;
      favorite: boolean;
      lastUsedAt: number | null;
    }
  | { op: 'delete'; id: string }
  | { op: 'restore'; id: string };

/** Encrypt an item into the operation that will store it. */
export async function toUpsert(
  keys: AccountKeys,
  item: {
    id: string;
    data: VaultItemData;
    folderId?: string | null;
    favorite?: boolean;
    lastUsedAt?: number | null;
  },
): Promise<Operation> {
  const dataEnc = await encryptJson(keys.dataKey, item.data);

  // Only logins carry a URL worth indexing, and the index is keyed by the
  // Account Key, so the server sees a tag it cannot invert.
  const url = item.data.type === 'login' ? item.data.fields.url : undefined;

  return {
    op: 'upsert',
    id: item.id,
    type: item.data.type,
    dataEnc,
    folderId: item.folderId ?? null,
    urlBlindIndex: url ? await blindIndexUrl(keys.blindIndexKey, url) : null,
    favorite: item.favorite ?? false,
    lastUsedAt: item.lastUsedAt ?? null,
  };
}

/** Send a batch of changes. */
export async function push(operations: Operation[]): Promise<number> {
  if (operations.length === 0) return 0;

  const response = await fetch('/api/vault/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ operations }),
  });

  if (!response.ok) {
    throw new Error('Could not save to the vault.');
  }

  const body = (await response.json()) as { cursor: number };
  return body.cursor;
}

/** A fresh item id. Generated client-side so an item exists before it syncs. */
export function newItemId(): string {
  return crypto.randomUUID();
}
