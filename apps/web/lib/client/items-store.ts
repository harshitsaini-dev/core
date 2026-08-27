'use client';

import type {
  DecryptedFolder,
  DecryptedItem,
  SyncedFolder,
  SyncedItem,
  VaultItemData,
} from '@core/shared';
import { create } from 'zustand';
import * as offline from './offline-db';
import {
  decryptCached,
  decryptFolders,
  folderOperationToSynced,
  isFolderOperation,
  newItemId,
  operationToSynced,
  pull,
  push,
  toFolderUpsert,
  toUpsert,
} from './vault-api';
import type { Operation } from './vault-api';
import { useVault } from './vault-store';

/**
 * The vault, offline first.
 *
 * Opening reads the local cache before it touches the network, so a vault opens
 * on a train exactly as it does at a desk. The network pull that follows is a
 * refresh, not a prerequisite — treating it as one is what makes most
 * "offline-capable" apps useless the moment they actually go offline.
 *
 * Writes go to memory, then to the cache and the outbox, then to the server.
 * If the last step fails the change is kept and retried. Discarding something a
 * user typed because a request failed is unacceptable here: what they typed may
 * be the only copy of a password generated seconds ago.
 *
 * This store holds plaintext and therefore has no persistence middleware. The
 * durable copy is the cache, which is encrypted twice over.
 */

interface ItemsState {
  readonly items: readonly DecryptedItem[];
  readonly folders: readonly DecryptedFolder[];
  readonly cursor: number;
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly online: boolean;
  readonly error: string | null;
  readonly pending: number;
  readonly undecryptable: readonly string[];

  load: () => Promise<void>;
  save: (data: VaultItemData, id?: string, folderId?: string | null) => Promise<string>;
  saveFolder: (name: string, options?: FolderOptions) => Promise<string>;
  removeFolder: (id: string) => Promise<void>;
  moveItem: (id: string, folderId: string | null) => Promise<void>;
  removeMany: (ids: readonly string[]) => Promise<void>;
  restoreMany: (ids: readonly string[]) => Promise<void>;
  moveMany: (ids: readonly string[], folderId: string | null) => Promise<void>;
  tagMany: (ids: readonly string[], tag: string) => Promise<void>;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  markUsed: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  flush: () => Promise<void>;
  setOnline: (online: boolean) => void;
  reset: () => void;
  wipeLocal: () => Promise<void>;
}

export interface FolderOptions {
  readonly id?: string;
  readonly parentId?: string | null;
  readonly color?: string | null;
  readonly sortOrder?: number;
}

const EMPTY = {
  items: [] as readonly DecryptedItem[],
  folders: [] as readonly DecryptedFolder[],
  cursor: 0,
  loading: false,
  syncing: false,
  online: true,
  error: null,
  pending: 0,
  undecryptable: [] as readonly string[],
};

/** The wire form of each item, kept so the cache can be written without re-encrypting. */
const raw = new Map<string, SyncedItem>();

/** The same, for folders. */
const rawFolders = new Map<string, SyncedFolder>();

function replace(
  items: readonly DecryptedItem[],
  id: string,
  update: (item: DecryptedItem) => DecryptedItem,
): DecryptedItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

export const useItems = create<ItemsState>((set, get) => ({
  ...EMPTY,

  setOnline: (online) => {
    set({ online });
    // Coming back from offline is the moment the queue is most likely to drain.
    if (online) void get().flush();
  },

  reset: () => {
    raw.clear();
    rawFolders.clear();
    set({ ...EMPTY, online: get().online });
  },

  wipeLocal: async () => {
    raw.clear();
    rawFolders.clear();
    set({ ...EMPTY, online: get().online });
    await offline.wipe();
  },

  load: async () => {
    const keys = useVault.getState().keys;
    if (!keys) return;

    set({ loading: true, error: null });

    // 1. The cache. This is what makes the vault usable without a network, and
    //    it is deliberately first: even online it paints before the request
    //    returns.
    try {
      const cached = await offline.readCache();
      if (cached.length > 0) {
        for (const row of cached) raw.set(row.id, row);
        const decrypted = await decryptCached(keys, cached);
        set({ items: decrypted.items, undecryptable: decrypted.undecryptable });
      }
      const cachedFolders = await offline.readFolderCache();
      if (cachedFolders.length > 0) {
        for (const row of cachedFolders) rawFolders.set(row.id, row);
        set({ folders: await decryptFolders(keys, cachedFolders) });
      }

      set({ cursor: await offline.readCursor(), pending: (await offline.readOutbox()).length });
    } catch {
      // A broken cache must not stop the vault opening; the server has it all.
    }

    // 2. Anything queued from a previous session, before pulling — otherwise a
    //    pull could overwrite a local change that was never delivered.
    await get().flush();

    // 3. The refresh.
    try {
      const result = await pull(keys, get().cursor);

      const merged = new Map(get().items.map((item) => [item.id, item]));
      for (const item of result.items) merged.set(item.id, item);
      for (const row of result.raw) raw.set(row.id, row);

      const mergedFolders = new Map(get().folders.map((folder) => [folder.id, folder]));
      for (const folder of result.folders) mergedFolders.set(folder.id, folder);
      for (const row of result.rawFolders) rawFolders.set(row.id, row);

      set({
        items: [...merged.values()],
        folders: [...mergedFolders.values()],
        cursor: result.cursor,
        undecryptable: result.undecryptable,
        loading: false,
        error: null,
        online: true,
      });

      await offline.writeCache(result.raw);
      await offline.writeFolderCache(result.rawFolders);
      await offline.writeCursor(result.cursor);
    } catch {
      set({
        loading: false,
        // A request that failed is better evidence than navigator.onLine, which
        // reports whether an interface is up rather than whether anything is
        // reachable. Set directly rather than through setOnline, which would
        // trigger a flush and fail the same way.
        online: false,
        // Not an error if there is something to show. A cached vault working
        // offline is the feature, not a degraded state to apologise for.
        error: get().items.length > 0 ? null : 'Could not reach the vault.',
      });
    }
  },

  save: async (data, id, folderId) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const itemId = id ?? newItemId();
    const now = Date.now();
    const existing = get().items.find((item) => item.id === itemId);

    const updated: DecryptedItem = {
      id: itemId,
      folderId: folderId === undefined ? (existing?.folderId ?? null) : folderId,
      favorite: existing?.favorite ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      data,
    };

    set({
      items: existing ? replace(get().items, itemId, () => updated) : [...get().items, updated],
    });

    await commit(
      set,
      get,
      await toUpsert(keys, {
        id: itemId,
        data,
        folderId: updated.folderId,
        favorite: updated.favorite,
        lastUsedAt: updated.lastUsedAt,
      }),
    );

    return itemId;
  },

  saveFolder: async (name, options = {}) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const id = options.id ?? newItemId();
    const now = Date.now();
    const existing = get().folders.find((folder) => folder.id === id);

    const parentId =
      (options.parentId === undefined ? existing?.parentId : options.parentId) ?? null;

    const updated: DecryptedFolder = {
      id,
      parentId: parentId === id ? null : parentId,
      name,
      color: (options.color === undefined ? existing?.color : options.color) ?? null,
      sortOrder: options.sortOrder ?? existing?.sortOrder ?? 0,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };

    set({
      folders: existing
        ? get().folders.map((folder) => (folder.id === id ? updated : folder))
        : [...get().folders, updated],
    });

    await commit(set, get, await toFolderUpsert(keys, updated));
    return id;
  },

  removeFolder: async (id) => {
    const deletedAt = Date.now();

    // The items inside are moved out rather than deleted, matching what the
    // server does. Doing it locally too means the vault does not briefly show
    // items filed under a folder that no longer exists.
    set({
      folders: get().folders.map((folder) =>
        folder.id === id ? { ...folder, deletedAt } : folder,
      ),
      items: get().items.map((item) => (item.folderId === id ? { ...item, folderId: null } : item)),
    });

    await commit(set, get, { op: 'folder-delete', id });
  },

  moveItem: async (id, folderId) => {
    const keys = useVault.getState().keys;
    const item = get().items.find((candidate) => candidate.id === id);
    if (!keys || !item) return;

    set({ items: replace(get().items, id, (current) => ({ ...current, folderId })) });
    await commit(set, get, await toUpsert(keys, { ...item, folderId }));
  },

  removeMany: async (ids) => {
    const deletedAt = Date.now();
    const set_ = new Set(ids);

    set({
      items: get().items.map((item) => (set_.has(item.id) ? { ...item, deletedAt } : item)),
    });

    await commitMany(
      set,
      get,
      ids.map((id) => ({ op: 'delete' as const, id })),
    );
  },

  restoreMany: async (ids) => {
    const set_ = new Set(ids);

    set({
      items: get().items.map((item) => (set_.has(item.id) ? { ...item, deletedAt: null } : item)),
    });

    await commitMany(
      set,
      get,
      ids.map((id) => ({ op: 'restore' as const, id })),
    );
  },

  moveMany: async (ids, folderId) => {
    const keys = useVault.getState().keys;
    if (!keys) return;

    const wanted = new Set(ids);
    const affected = get().items.filter((item) => wanted.has(item.id));

    set({
      items: get().items.map((item) => (wanted.has(item.id) ? { ...item, folderId } : item)),
    });

    await commitMany(
      set,
      get,
      await Promise.all(affected.map((item) => toUpsert(keys, { ...item, folderId }))),
    );
  },

  tagMany: async (ids, tag) => {
    const keys = useVault.getState().keys;
    const trimmed = tag.trim();
    if (!keys || trimmed === '') return;

    const wanted = new Set(ids);
    const now = Date.now();

    // Added, never replaced. A bulk action that discarded the tags an item
    // already had would be a silent edit of every item it touched.
    const updated = get().items.map((item) => {
      if (!wanted.has(item.id)) return item;
      const existing = item.data.fields.tags ?? [];
      if (existing.includes(trimmed)) return item;

      return {
        ...item,
        updatedAt: now,
        data: {
          ...item.data,
          fields: { ...item.data.fields, tags: [...existing, trimmed] },
        },
      } as DecryptedItem;
    });

    set({ items: updated });

    const changed = updated.filter((item) => wanted.has(item.id));
    await commitMany(set, get, await Promise.all(changed.map((item) => toUpsert(keys, item))));
  },

  setFavorite: async (id, favorite) => {
    const keys = useVault.getState().keys;
    const item = get().items.find((candidate) => candidate.id === id);
    if (!keys || !item) return;

    set({ items: replace(get().items, id, (current) => ({ ...current, favorite })) });
    await commit(set, get, await toUpsert(keys, { ...item, favorite }));
  },

  markUsed: async (id) => {
    const keys = useVault.getState().keys;
    const item = get().items.find((candidate) => candidate.id === id);
    if (!keys || !item) return;

    const lastUsedAt = Date.now();
    set({ items: replace(get().items, id, (current) => ({ ...current, lastUsedAt })) });
    await commit(set, get, await toUpsert(keys, { ...item, lastUsedAt }));
  },

  remove: async (id) => {
    const deletedAt = Date.now();
    set({ items: replace(get().items, id, (current) => ({ ...current, deletedAt })) });
    await commit(set, get, { op: 'delete', id });
  },

  restore: async (id) => {
    set({ items: replace(get().items, id, (current) => ({ ...current, deletedAt: null })) });
    await commit(set, get, { op: 'restore', id });
  },

  flush: async () => {
    if (get().syncing) return;

    const queued = await offline.readOutbox();
    set({ pending: queued.length });
    if (queued.length === 0) return;

    set({ syncing: true });
    try {
      const cursor = await push(queued.map((entry) => entry.operation));
      await offline.clearOutbox(queued.map((entry) => entry.operation.id));
      await offline.writeCursor(Math.max(get().cursor, cursor));

      set({
        syncing: false,
        pending: 0,
        error: null,
        online: true,
        cursor: Math.max(get().cursor, cursor),
      });
    } catch {
      await offline.recordFailure(queued.map((entry) => entry.operation.id));
      set({
        syncing: false,
        online: false,
        pending: queued.length,
        // Phrased as a statement of fact rather than a failure. The change is
        // safe on this device; it simply has not travelled yet.
        error: 'Saved on this device. Waiting to sync.',
      });
    }
  },
}));

type Setter = (partial: Partial<ItemsState>) => void;
type Getter = () => ItemsState;

/**
 * Persist a change locally, then try to send it.
 *
 * The local writes happen first and are awaited. If the process dies between
 * the cache write and the push, the change survives and the outbox delivers it
 * next time — which is the whole reason the queue is on disk rather than in
 * memory.
 */
async function commit(set: Setter, get: Getter, operation: Operation): Promise<void> {
  if (isFolderOperation(operation)) {
    const cached = folderOperationToSynced(operation, rawFolders.get(operation.id));
    if (cached) {
      rawFolders.set(operation.id, cached);
      await offline.writeFolderCache([cached]);
    }
  } else {
    const cached = operationToSynced(operation, raw.get(operation.id));
    if (cached) {
      raw.set(operation.id, cached);
      await offline.writeCache([cached]);
    }
  }

  await offline.enqueueOperation(operation);
  set({ pending: (await offline.readOutbox()).length });

  await get().flush();
}

/**
 * Persist a batch, then send it once.
 *
 * The single-operation path flushes after every change, which is right when a
 * change is something a person just typed. For a bulk action it would be one
 * round trip per item — fifty selected items, fifty requests, and fifty chances
 * for the network to fail halfway through a single intended action.
 */
async function commitMany(set: Setter, get: Getter, operations: Operation[]): Promise<void> {
  for (const operation of operations) {
    if (isFolderOperation(operation)) {
      const cached = folderOperationToSynced(operation, rawFolders.get(operation.id));
      if (cached) {
        rawFolders.set(operation.id, cached);
        await offline.writeFolderCache([cached]);
      }
    } else {
      const cached = operationToSynced(operation, raw.get(operation.id));
      if (cached) {
        raw.set(operation.id, cached);
        await offline.writeCache([cached]);
      }
    }

    await offline.enqueueOperation(operation);
  }

  set({ pending: (await offline.readOutbox()).length });
  await get().flush();
}

/**
 * Track connectivity.
 *
 * `navigator.onLine` is a weak signal: it reports whether an interface is up,
 * not whether anything is reachable, and it can stay true on a captive portal
 * or a dead uplink. So it is only half of the answer — a request that actually
 * failed marks the app offline too, and a request that succeeded marks it back
 * online. The events are what let it recover promptly rather than waiting for
 * the next attempt.
 *
 * Going offline is never inferred from the browser saying so alone, because
 * the reverse mistake matters more: telling somebody their change is synced
 * when it is sitting in a queue is worse than a stale "offline".
 */
export function watchConnectivity(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const update = (): void => {
    // Only the browser going offline is trusted outright. Coming back online is
    // treated as a hint to retry, and the retry decides.
    if (!navigator.onLine) {
      useItems.setState({ online: false });
      return;
    }
    useItems.getState().setOnline(true);
  };

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();

  return () => {
    window.removeEventListener('online', update);
    window.removeEventListener('offline', update);
  };
}

/** Items that are not in the trash. */
export function activeItems(items: readonly DecryptedItem[]): DecryptedItem[] {
  return items.filter((item) => item.deletedAt === null);
}

/** Items that are. */
export function trashedItems(items: readonly DecryptedItem[]): DecryptedItem[] {
  return items.filter((item) => item.deletedAt !== null);
}

/** Folders that still exist. Deleted ones stay in state so a sync can undo them. */
export function activeFolders(folders: readonly DecryptedFolder[]): DecryptedFolder[] {
  return folders.filter((folder) => folder.deletedAt === null);
}
