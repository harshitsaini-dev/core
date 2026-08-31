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
  toItemVersion,
  toUpsert,
} from './vault-api';
import type { ItemVersion, Operation } from './vault-api';
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
  /**
   * Versions written in this session, by item id.
   *
   * The environment manager learned this the hard way: a read straight after a
   * write does not reliably include the row, and a history panel that then says
   * "no earlier versions" states something false with complete confidence. The
   * client already knows what it replaced.
   */
  readonly recentVersions: Readonly<Record<string, ItemVersion[]>>;

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
  /** Permanent. Takes the item's versions and attachments with it. */
  purge: (id: string) => Promise<void>;
  purgeMany: (ids: readonly string[]) => Promise<void>;
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
  recentVersions: {} as Readonly<Record<string, ItemVersion[]>>,
};

/**
 * Combine what is on screen with what the server sent, keeping the newer of
 * each.
 *
 * The pull that runs on mount can still be in flight when somebody changes
 * something — and on a slow connection, or a machine running four browsers at
 * once, "still in flight" is seconds rather than milliseconds. It returns each
 * item as it was when the request left, which is older than a change made
 * since.
 *
 * Letting the response win reverts that change on screen while the outbox still
 * holds it, so it returns on the next refresh. Nothing is lost, but the vault
 * appears to undo something a person just typed, which is worse than it sounds
 * on a product about not losing things.
 *
 * This only works if every local change looks newer, which is why `replace`
 * stamps `updatedAt`. Deleting was the case that showed it: `deletedAt` moved,
 * `updatedAt` did not, and the next pull brought the item back.
 *
 * Compared on a browser clock against a server one. A skew resolves in favour
 * of the local copy, which is the safe direction: it has been queued, so the
 * next pull agrees.
 */
export function mergeNewest<T extends { id: string; updatedAt: number }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = new Map(local.map((entry) => [entry.id, entry]));

  for (const entry of incoming) {
    const mine = merged.get(entry.id);
    if (!mine || entry.updatedAt >= mine.updatedAt) merged.set(entry.id, entry);
  }

  return [...merged.values()];
}

/** The wire form of each item, kept so the cache can be written without re-encrypting. */
const raw = new Map<string, SyncedItem>();

/** The same, for folders. */
const rawFolders = new Map<string, SyncedFolder>();

/**
 * Apply a change to one item, and stamp it as changed.
 *
 * The stamp is the point. `load` keeps whichever copy of an item is newer, so a
 * local edit that leaves `updatedAt` alone loses to the very next pull and
 * disappears from the screen — while sitting safely in the outbox, which makes
 * it look like the app silently undid what somebody just did.
 *
 * Deleting was the case that showed it: `deletedAt` moved, `updatedAt` did not,
 * and a refresh brought the item back.
 */
function replace(
  items: readonly DecryptedItem[],
  id: string,
  update: (item: DecryptedItem) => DecryptedItem,
): DecryptedItem[] {
  const now = Date.now();
  return items.map((item) => (item.id === id ? { ...update(item), updatedAt: now } : item));
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

      const merged = mergeNewest(get().items, result.items);
      for (const row of result.raw) raw.set(row.id, row);

      const mergedFolders = mergeNewest(get().folders, result.folders);
      for (const row of result.rawFolders) rawFolders.set(row.id, row);

      set({
        items: merged,
        folders: mergedFolders,
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

    // The contents an edit replaced, kept so it can be looked at and put back.
    // Recorded only when something actually differs: saving an item without
    // touching it should not fill the history with copies of itself.
    if (existing && JSON.stringify(existing.data) !== JSON.stringify(data)) {
      set({
        recentVersions: {
          ...get().recentVersions,
          [itemId]: [
            { id: newItemId(), data: existing.data, createdAt: now },
            ...(get().recentVersions[itemId] ?? []),
          ],
        },
      });

      await commit(set, get, await toItemVersion(keys, existing));
    }

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
      items: get().items.map((item) =>
        item.folderId === id ? { ...item, folderId: null, updatedAt: deletedAt } : item,
      ),
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
      items: get().items.map((item) =>
        set_.has(item.id) ? { ...item, deletedAt, updatedAt: deletedAt } : item,
      ),
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
      items: get().items.map((item) =>
        set_.has(item.id) ? { ...item, deletedAt: null, updatedAt: Date.now() } : item,
      ),
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
      items: get().items.map((item) =>
        wanted.has(item.id) ? { ...item, folderId, updatedAt: Date.now() } : item,
      ),
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

  /**
   * Gone for good, with its versions and its attachments.
   *
   * The one action in this store with no way back. Removed from local state
   * immediately rather than marked, because there is no state left to be in:
   * every other operation here leaves a row that a later sync can reconcile,
   * and this one leaves nothing to reconcile with.
   */
  purge: async (id) => {
    set({ items: get().items.filter((item) => item.id !== id) });
    await commit(set, get, { op: 'purge', id });
  },

  purgeMany: async (ids) => {
    const gone = new Set(ids);
    set({ items: get().items.filter((item) => !gone.has(item.id)) });

    // `commitMany`, not `commit` in a loop. `flush` returns immediately while a
    // sync is already running, so the loop sent the first purge and left every
    // one after it sitting in the outbox until something else happened to
    // flush — emptying a trash of five deleted one item and looked like it had
    // done all five.
    await commitMany(
      set,
      get,
      ids.map((id) => ({ op: 'purge' as const, id })),
    );
  },

  flush: async () => {
    if (get().syncing) return;

    const queued = await offline.readOutbox();
    set({ pending: queued.length });
    if (queued.length === 0) return;

    set({ syncing: true });
    try {
      const cursor = await push(queued.map((entry) => entry.operation));
      // By the key it was stored under: a purge is queued under its own, so
      // clearing by item id would leave it in the outbox to be sent again.
      await offline.clearOutbox(queued.map((entry) => offline.outboxKey(entry.operation)));
      await offline.writeCursor(Math.max(get().cursor, cursor));

      /*
       * What is left, not zero.
       *
       * `queued` is a snapshot taken before the request. Anything enqueued
       * while it was in flight is still in the outbox, and declaring the queue
       * empty here stopped the retry poll from ever looking again — it only
       * runs while `pending > 0`. The change sat there until the user happened
       * to do something else that flushed.
       *
       * It is not hypothetical: emptying the trash queues a purge while the
       * delete before it is still being sent, and the purge was never
       * delivered. The screen said the trash was empty and every row was still
       * on the server.
       */
      const remaining = (await offline.readOutbox()).length;

      set({
        syncing: false,
        pending: remaining,
        error: null,
        online: true,
        cursor: Math.max(get().cursor, cursor),
      });

      // Straight away rather than waiting for the poll. This terminates: each
      // pass sends and clears what it read, so the queue strictly shrinks.
      if (remaining > 0) await get().flush();
    } catch {
      await offline.recordFailure(queued.map((entry) => offline.outboxKey(entry.operation)));
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
/** How often a queued change is retried once the browser is back. */
const RETRY_INTERVAL_MS = 3000;

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

  /**
   * A retry that does not depend on being told.
   *
   * The outbox used to drain on exactly two triggers: a new write, and the
   * browser firing `online`. Both can be missed. If a flush is already in
   * flight when `online` arrives, the guard turns the second one away — and
   * when the first finally fails, nothing is left to try again. The app then
   * sits showing "offline" with a change in the queue until somebody happens to
   * edit something else.
   *
   * That is not a hypothetical either: it is what left a reconnected vault
   * stuck offline for the full thirty seconds a test was willing to wait.
   *
   * So: a slow poll, only while there is something queued and the browser
   * believes it has a network. It costs nothing when the queue is empty, which
   * is almost always.
   */
  const retry = setInterval(() => {
    const state = useItems.getState();
    if (state.pending > 0 && !state.syncing && navigator.onLine) void state.flush();
  }, RETRY_INTERVAL_MS);

  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();

  return () => {
    clearInterval(retry);
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
