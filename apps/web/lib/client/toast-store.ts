'use client';

import { create } from 'zustand';

/**
 * Toasts.
 *
 * One rule that is not a style choice: **a toast never carries a value**. Not a
 * password, not a username, not a note. They appear unprompted, they linger,
 * and they are the single most likely thing on this screen to end up in a
 * screen recording or over a shoulder. "Copied" says everything the person
 * needs; "Copied hunter2" says it to the room.
 *
 * The second rule is about what belongs here at all. A toast is for something
 * that *happened* — copied, deleted, synced. A condition that *persists* —
 * offline, four changes waiting — stays in the interface, because a message
 * that disappears is the wrong shape for a state that does not.
 */

export type ToastTone = 'info' | 'warning' | 'danger';

export interface Toast {
  readonly id: string;
  readonly message: string;
  readonly tone: ToastTone;
  /** An optional single action, e.g. undo. */
  readonly action?: { readonly label: string; readonly run: () => void } | undefined;
}

/** Everything about a toast except the text and the identity. */
export type ToastOptions = Partial<Omit<Toast, 'id' | 'message'>>;

interface ToastState {
  readonly toasts: readonly Toast[];
  push: (message: string, options?: ToastOptions) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

/** How long a toast stays before it withdraws itself. */
export const TOAST_LIFETIME_MS = 4000;

/** How many are shown at once. Older ones are dropped, not queued. */
const MAX_VISIBLE = 3;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],

  push: (message, options = {}) => {
    const id = crypto.randomUUID();
    const toast: Toast = { id, message, tone: options.tone ?? 'info', action: options.action };

    // Dropped rather than queued. A backlog of stale confirmations arriving one
    // after another is noise, and by the time the fourth is shown nobody
    // remembers what it refers to.
    set({ toasts: [...get().toasts, toast].slice(-MAX_VISIBLE) });

    // A toast with an action stays until it is answered. Withdrawing an "undo"
    // on a timer means the only way to reverse something disappears while the
    // person is still reading what happened.
    if (!options.action) {
      setTimeout(() => get().dismiss(id), TOAST_LIFETIME_MS);
    }

    return id;
  },

  dismiss: (id) => set({ toasts: get().toasts.filter((toast) => toast.id !== id) }),

  clear: () => set({ toasts: [] }),
}));

/** Announce something that happened. */
export function toast(message: string, options?: ToastOptions): string {
  return useToasts.getState().push(message, options);
}
