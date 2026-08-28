'use client';

import { create } from 'zustand';

/**
 * What the generator produced during this session.
 *
 * It exists for one specific mistake, which is common and currently
 * unrecoverable: generate a password, paste it into a signup form, generate
 * another one before saving the first, and the account now has a password
 * nothing remembers.
 *
 * **Never persisted, and it cannot be.** Zustand's `persist` here would write a
 * list of freshly generated passwords to `localStorage` in the clear — outside
 * the vault, outside the encrypted cache, readable by anything with access to
 * the profile, and surviving the lock that is supposed to end access. Whatever
 * convenience that would buy is not close to worth it, so the store has no
 * persistence and the list is cleared when the vault locks.
 *
 * A short cap for the same reason: this is a safety net for the last few
 * minutes, not a second place secrets accumulate. Anything worth keeping
 * belongs in an item.
 */

/** How many to keep. Long enough to catch the mistake, short enough not to be a store. */
export const HISTORY_LIMIT = 10;

export interface GeneratedValue {
  readonly value: string;
  /** What produced it, so a list of mixed shapes is readable. */
  readonly kind: string;
}

interface HistoryState {
  readonly items: readonly GeneratedValue[];
  remember: (value: string, kind: string) => void;
  /** Called on lock and on panic. The list holds plaintext secrets. */
  clear: () => void;
}

export const useGeneratorHistory = create<HistoryState>((set, get) => ({
  items: [],

  remember: (value, kind) => {
    const items = get().items;

    // Regenerating without using the last one is the normal case, so an
    // identical repeat is dropped rather than filling the list with duplicates.
    if (items[0]?.value === value) return;

    set({ items: [{ value, kind }, ...items].slice(0, HISTORY_LIMIT) });
  },

  clear: () => set({ items: [] }),
}));
