'use client';

import { create } from 'zustand';

/**
 * How the vault is laid out, and what is selected in it.
 *
 * The layout is the one thing in this app worth writing to `localStorage`. It
 * holds no vault data — "this person prefers a grid" is not a secret, and
 * re-choosing it on every visit is the kind of small friction that makes a
 * product feel unfinished. Everything else stays in memory or in the encrypted
 * cache.
 *
 * The selection deliberately does not persist. A set of item ids restored after
 * a reload would be a list of what somebody was about to delete, sitting in
 * plain text on disk, describing a vault the browser can no longer open.
 */

export type Layout = 'list' | 'grid';

const LAYOUT_KEY = 'core.layout';

function readLayout(): Layout {
  if (typeof localStorage === 'undefined') return 'list';
  return localStorage.getItem(LAYOUT_KEY) === 'grid' ? 'grid' : 'list';
}

interface ViewState {
  readonly layout: Layout;
  readonly selected: ReadonlySet<string>;
  readonly selecting: boolean;

  setLayout: (layout: Layout) => void;
  /** Read the stored preference. Called after mount, never during render. */
  hydrate: () => void;

  startSelecting: () => void;
  stopSelecting: () => void;
  toggle: (id: string) => void;
  selectAll: (ids: readonly string[]) => void;
  clear: () => void;
}

export const useView = create<ViewState>((set, get) => ({
  // Starts on the default rather than on the stored value: reading
  // `localStorage` during the first render disagrees with what the server
  // rendered, and React replaces the whole tree when it notices.
  layout: 'list',
  selected: new Set<string>(),
  selecting: false,

  setLayout: (layout) => {
    set({ layout });
    try {
      localStorage.setItem(LAYOUT_KEY, layout);
    } catch {
      // Private mode, a full quota, a browser with storage switched off. The
      // preference is worth remembering and not worth failing over.
    }
  },

  hydrate: () => set({ layout: readLayout() }),

  startSelecting: () => set({ selecting: true }),

  stopSelecting: () => set({ selecting: false, selected: new Set<string>() }),

  toggle: (id) => {
    const next = new Set(get().selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    set({ selected: next });
  },

  selectAll: (ids) => set({ selected: new Set(ids) }),

  clear: () => set({ selected: new Set<string>() }),
}));
