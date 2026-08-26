'use client';

import type { AccountKeys } from '@core/crypto';
import { create } from 'zustand';
import { logout } from './auth';

/**
 * Vault lock state.
 *
 * The Account Keys live here and nowhere else. Three rules follow from that,
 * and every one of them is a way this could go quietly wrong:
 *
 *   1. **No persistence middleware.** Zustand's `persist` would write the store
 *      to localStorage, which for this store means writing the keys that
 *      decrypt the entire vault to disk in the clear. There is no configuration
 *      of it that would be acceptable here, so it is simply not used.
 *
 *   2. **Locking drops the reference.** `CryptoKey` objects are opaque handles
 *      and cannot be zeroed from JavaScript, so the best available is to release
 *      them and let the engine collect them. That is also why the keys are
 *      non-extractable in the first place: even holding one, application code
 *      cannot serialise it.
 *
 *   3. **Locking is not logging out.** The session stays valid; only the keys
 *      go. Unlocking again needs the master password but not another round trip
 *      through login.
 */

/** How long without interaction before the vault locks itself. */
export const DEFAULT_AUTO_LOCK_MS = 5 * 60 * 1000;

export type LockState = 'locked' | 'unlocked';

interface VaultState {
  readonly state: LockState;
  /** Present only while unlocked. Never serialised, never persisted. */
  readonly keys: AccountKeys | null;
  /** Milliseconds of inactivity before an automatic lock. */
  readonly autoLockMs: number;
  /** Set when the vault locked itself rather than being locked by the user. */
  readonly lockedAutomatically: boolean;

  unlock: (keys: AccountKeys) => void;
  lock: (automatic?: boolean) => void;
  setAutoLockMs: (ms: number) => void;
  /** Lock, then end the session. Used by the panic button and by sign-out. */
  panic: () => Promise<void>;
}

export const useVault = create<VaultState>((set, get) => ({
  state: 'locked',
  keys: null,
  autoLockMs: DEFAULT_AUTO_LOCK_MS,
  lockedAutomatically: false,

  unlock: (keys) => set({ state: 'unlocked', keys, lockedAutomatically: false }),

  lock: (automatic = false) =>
    set({ state: 'locked', keys: null, lockedAutomatically: automatic }),

  setAutoLockMs: (ms) => set({ autoLockMs: ms }),

  panic: async () => {
    // Lock first. If the network call hangs, the keys are already gone — which
    // is the order that matters when someone is reaching for this in a hurry.
    get().lock(false);
    await logout();
  },
}));

/** Read the keys, or throw. Callers that need a vault should not be guessing. */
export function requireKeys(): AccountKeys {
  const { keys } = useVault.getState();
  if (!keys) {
    throw new Error('The vault is locked.');
  }
  return keys;
}

/**
 * Start the inactivity timer.
 *
 * Returns a teardown function. Deliberately driven by real user events rather
 * than a bare interval: a background tab should not keep a vault unlocked just
 * because time is passing somewhere.
 */
export function startAutoLock(): () => void {
  if (typeof window === 'undefined') return () => undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;

  const reset = (): void => {
    if (timer) clearTimeout(timer);
    if (useVault.getState().state !== 'unlocked') return;

    timer = setTimeout(() => {
      useVault.getState().lock(true);
    }, useVault.getState().autoLockMs);
  };

  const events = ['pointerdown', 'keydown', 'visibilitychange'] as const;
  for (const event of events) {
    window.addEventListener(event, reset, { passive: true });
  }

  const unsubscribe = useVault.subscribe(reset);
  reset();

  return () => {
    if (timer) clearTimeout(timer);
    for (const event of events) {
      window.removeEventListener(event, reset);
    }
    unsubscribe();
  };
}
