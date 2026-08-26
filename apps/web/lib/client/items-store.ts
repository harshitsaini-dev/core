'use client';

import type { DecryptedItem, VaultItemData } from '@core/shared';
import { create } from 'zustand';
import { newItemId, pull, push, toUpsert } from './vault-api';
import type { Operation } from './vault-api';
import { useVault } from './vault-store';

/**
 * The decrypted vault, in memory.
 *
 * Writes are optimistic: the local copy changes first and the server is told
 * afterwards. On a vault that has to work offline that is not an optimisation,
 * it is the only order that works — the alternative is a UI that freezes on
 * every keystroke and stops entirely on a train.
 *
 * When a push fails the change is kept and queued rather than rolled back.
 * Silently discarding something a user typed is worse than showing it as
 * unsaved, especially here, where what they typed may be the only copy of a
 * password they just generated.
 *
 * Like the key store, this deliberately has no persistence middleware. It holds
 * plaintext.
 */

export interface PendingOperation {
  readonly operation: Operation;
  readonly attempts: number;
}

interface ItemsState {
  readonly items: readonly DecryptedItem[];
  readonly cursor: number;
  readonly loading: boolean;
  readonly syncing: boolean;
  readonly error: string | null;
  /** Ids the server sent that this client could not decrypt. */
  readonly undecryptable: readonly string[];
  /** Changes not yet accepted by the server. */
  readonly outbox: readonly PendingOperation[];

  load: () => Promise<void>;
  save: (data: VaultItemData, id?: string) => Promise<string>;
  setFavorite: (id: string, favorite: boolean) => Promise<void>;
  markUsed: (id: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
  flush: () => Promise<void>;
  reset: () => void;
}

const EMPTY = {
  items: [] as readonly DecryptedItem[],
  cursor: 0,
  loading: false,
  syncing: false,
  error: null,
  undecryptable: [] as readonly string[],
  outbox: [] as readonly PendingOperation[],
};

function replace(
  items: readonly DecryptedItem[],
  id: string,
  update: (item: DecryptedItem) => DecryptedItem,
): DecryptedItem[] {
  return items.map((item) => (item.id === id ? update(item) : item));
}

export const useItems = create<ItemsState>((set, get) => ({
  ...EMPTY,

  reset: () => set({ ...EMPTY }),

  load: async () => {
    const keys = useVault.getState().keys;
    if (!keys) return;

    set({ loading: true, error: null });
    try {
      const result = await pull(keys, get().cursor);

      // Merge rather than replace: a delta pull only carries what changed, and
      // the local copy may hold items this pull did not mention.
      const merged = new Map(get().items.map((item) => [item.id, item]));
      for (const item of result.items) {
        merged.set(item.id, item);
      }

      set({
        items: [...merged.values()],
        cursor: result.cursor,
        undecryptable: result.undecryptable,
        loading: false,
      });
    } catch {
      set({ loading: false, error: 'Could not reach the vault.' });
    }
  },

  save: async (data, id) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const itemId = id ?? newItemId();
    const now = Date.now();
    const existing = get().items.find((item) => item.id === itemId);

    const updated: DecryptedItem = {
      id: itemId,
      folderId: existing?.folderId ?? null,
      favorite: existing?.favorite ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
      lastUsedAt: existing?.lastUsedAt ?? null,
      data,
    };

    set({
      items: existing
        ? replace(get().items, itemId, () => updated)
        : [...get().items, updated],
    });

    await enqueue(
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

  setFavorite: async (id, favorite) => {
    const keys = useVault.getState().keys;
    const item = get().items.find((candidate) => candidate.id === id);
    if (!keys || !item) return;

    set({ items: replace(get().items, id, (current) => ({ ...current, favorite })) });
    await enqueue(set, get, await toUpsert(keys, { ...item, favorite }));
  },

  markUsed: async (id) => {
    const keys = useVault.getState().keys;
    const item = get().items.find((candidate) => candidate.id === id);
    if (!keys || !item) return;

    const lastUsedAt = Date.now();
    set({ items: replace(get().items, id, (current) => ({ ...current, lastUsedAt })) });
    await enqueue(set, get, await toUpsert(keys, { ...item, lastUsedAt }));
  },

  remove: async (id) => {
    // Soft, matching the server. The item stays in memory with deletedAt set so
    // trash can list it without another round trip.
    const deletedAt = Date.now();
    set({ items: replace(get().items, id, (current) => ({ ...current, deletedAt })) });
    await enqueue(set, get, { op: 'delete', id });
  },

  restore: async (id) => {
    set({ items: replace(get().items, id, (current) => ({ ...current, deletedAt: null })) });
    await enqueue(set, get, { op: 'restore', id });
  },

  flush: async () => {
    const pending = get().outbox;
    if (pending.length === 0 || get().syncing) return;

    set({ syncing: true });
    try {
      const cursor = await push(pending.map((entry) => entry.operation));
      set({ outbox: [], syncing: false, error: null, cursor: Math.max(get().cursor, cursor) });
    } catch {
      set({
        syncing: false,
        error: 'Changes are saved on this device but not yet synced.',
        outbox: pending.map((entry) => ({ ...entry, attempts: entry.attempts + 1 })),
      });
    }
  },
}));

type Setter = (partial: Partial<ItemsState>) => void;
type Getter = () => ItemsState;

/** Queue an operation and try to send it immediately. */
async function enqueue(set: Setter, get: Getter, operation: Operation): Promise<void> {
  // Replace any earlier queued operation for the same item: only the latest
  // state matters, and sending three versions of one item wastes a round trip
  // to arrive at the same place.
  const outbox = [
    ...get().outbox.filter((entry) => entry.operation.id !== operation.id),
    { operation, attempts: 0 },
  ];

  set({ outbox });
  await get().flush();
}

/** Items that are not in the trash. */
export function activeItems(items: readonly DecryptedItem[]): DecryptedItem[] {
  return items.filter((item) => item.deletedAt === null);
}

/** Items that are. */
export function trashedItems(items: readonly DecryptedItem[]): DecryptedItem[] {
  return items.filter((item) => item.deletedAt !== null);
}
