import {
  blindIndexUrl,
  decryptJson,
  decryptString,
  encryptJson,
  encryptString,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import { vaultItemDataSchema } from '@core/shared';
import type {
  DecryptedFolder,
  DecryptedItem,
  SyncedFolder,
  SyncedItem,
  VaultItemData,
} from '@core/shared';

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
  folders: SyncedFolder[];
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
  readonly folders: DecryptedFolder[];
  readonly rawFolders: SyncedFolder[];
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
 * A folder whose name will not open is still shown, under a placeholder.
 *
 * The alternative is dropping it, which would silently hide every item inside
 * it — the same failure as losing the items, arrived at from the other side.
 */
async function decryptFolder(keys: AccountKeys, row: SyncedFolder): Promise<DecryptedFolder> {
  let name: string;
  try {
    name = await decryptString(keys.dataKey, row.nameEnc);
  } catch {
    name = 'Unreadable folder';
  }

  return {
    id: row.id,
    parentId: row.parentId,
    name,
    color: row.color,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
  };
}

/** Decrypt folder rows that came from the cache rather than the network. */
export async function decryptFolders(
  keys: AccountKeys,
  rows: readonly SyncedFolder[],
): Promise<DecryptedFolder[]> {
  return Promise.all(rows.map((row) => decryptFolder(keys, row)));
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

  const folders = await decryptFolders(keys, body.folders ?? []);

  return {
    items,
    raw: body.items,
    folders,
    rawFolders: body.folders ?? [],
    undecryptable,
    cursor: body.cursor,
  };
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
  if (isFolderOperation(operation)) return null;

  // A version is a new row of its own, not a change to the item. Falling
  // through would look up the *version's* id in the item cache — which happens
  // to miss today, and would quietly clear an item's `deletedAt` on the day two
  // ids ever collided.
  if (operation.op === 'version') return null;

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

/** The wire form of a locally-created folder, for the same reason as items. */
export function folderOperationToSynced(
  operation: FolderOperation,
  existing?: SyncedFolder,
): SyncedFolder | null {
  const now = Date.now();

  if (operation.op === 'folder-delete') {
    return existing ? { ...existing, deletedAt: now, updatedAt: now } : null;
  }

  return {
    id: operation.id,
    parentId: operation.parentId,
    nameEnc: operation.nameEnc,
    color: operation.color,
    sortOrder: operation.sortOrder,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    deletedAt: null,
  };
}

export type FolderOperation =
  | {
      op: 'folder-upsert';
      id: string;
      nameEnc: string;
      parentId: string | null;
      color: string | null;
      sortOrder: number;
    }
  | { op: 'folder-delete'; id: string };

export function isFolderOperation(operation: Operation): operation is FolderOperation {
  return operation.op === 'folder-upsert' || operation.op === 'folder-delete';
}

export type Operation =
  | FolderOperation
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
  | { op: 'restore'; id: string }
  | { op: 'purge'; id: string }
  | { op: 'version'; id: string; itemId: string; dataEnc: string };

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

/**
 * Encrypt a folder into the operation that will store it.
 *
 * A folder cannot be its own parent — the server rejects that too, but catching
 * it here means the tree never briefly renders as unwalkable while the round
 * trip is in flight.
 */
export async function toFolderUpsert(
  keys: AccountKeys,
  folder: {
    id: string;
    name: string;
    parentId?: string | null;
    color?: string | null;
    sortOrder?: number;
  },
): Promise<FolderOperation> {
  const parentId = folder.parentId ?? null;

  return {
    op: 'folder-upsert',
    id: folder.id,
    nameEnc: await encryptString(keys.dataKey, folder.name),
    parentId: parentId === folder.id ? null : parentId,
    color: folder.color ?? null,
    sortOrder: folder.sortOrder ?? 0,
  };
}

export interface ItemVersion {
  readonly id: string;
  readonly data: VaultItemData;
  readonly createdAt: number;
}

/** The contents an edit is about to replace, ready to store. */
export async function toItemVersion(
  keys: AccountKeys,
  previous: { id: string; data: VaultItemData },
): Promise<Operation> {
  return {
    op: 'version',
    id: crypto.randomUUID(),
    itemId: previous.id,
    dataEnc: await encryptJson(keys.dataKey, previous.data),
  };
}

/**
 * The previous versions of one item.
 *
 * Asked for when somebody opens the history, not carried by every sync: a vault
 * of three hundred items would otherwise ship three thousand blobs nobody asked
 * to see.
 */
export async function fetchItemHistory(keys: AccountKeys, itemId: string): Promise<ItemVersion[]> {
  const response = await fetch(`/api/vault/history?itemId=${encodeURIComponent(itemId)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Could not load the history.');

  const body = (await response.json()) as {
    versions: { id: string; dataEnc: string; createdAt: number }[];
  };

  const decrypted = await Promise.all(
    body.versions.map(async (row) => {
      try {
        const parsed = vaultItemDataSchema.safeParse(
          await decryptJson<unknown>(keys.dataKey, row.dataEnc),
        );
        if (!parsed.success) return null;
        return { id: row.id, data: parsed.data, createdAt: row.createdAt };
      } catch {
        return null;
      }
    }),
  );

  // A version that will not open is dropped rather than shown as a broken row.
  // Unlike a current item, there is nothing to lose by omitting it: the value
  // it held is gone either way, and a placeholder in a history list is noise.
  return decrypted.filter((entry): entry is ItemVersion => entry !== null);
}

/** A fresh item id. Generated client-side so an item exists before it syncs. */
export function newItemId(): string {
  return crypto.randomUUID();
}
