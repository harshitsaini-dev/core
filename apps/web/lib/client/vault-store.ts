'use client';

import type { AccountKeys } from '@core/crypto';
import { create } from 'zustand';
import { logout } from './auth';
import { useLockSettings } from './lock-settings';
import * as offline from './offline-db';

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

export type LockState = 'locked' | 'unlocked';

interface VaultState {
  readonly state: LockState;
  /** Present only while unlocked. Never serialised, never persisted. */
  readonly keys: AccountKeys | null;
  /** Set when the vault locked itself rather than being locked by the user. */
  readonly lockedAutomatically: boolean;

  unlock: (keys: AccountKeys) => void;
  lock: (automatic?: boolean) => void;
  /** Lock, then end the session. Used by the panic button and by sign-out. */
  panic: () => Promise<void>;
}

export const useVault = create<VaultState>((set, get) => ({
  state: 'locked',
  keys: null,
  lockedAutomatically: false,

  unlock: (keys) => set({ state: 'unlocked', keys, lockedAutomatically: false }),

  lock: (automatic = false) => set({ state: 'locked', keys: null, lockedAutomatically: automatic }),

  panic: async () => {
    // Lock first. If anything after this hangs, the keys are already gone —
    // which is the order that matters when somebody is reaching for this in a
    // hurry.
    get().lock(false);

    // Then the local cache. Locking alone would leave an encrypted copy of the
    // vault on the device, which is exactly what this button exists to remove.
    // Anything the outbox had not delivered is lost with it; that is the right
    // trade for a control somebody presses because they want the data gone.
    //
    // Called directly rather than through a dynamic import of the items store.
    // That import was there to avoid a cycle between the two stores, and it
    // made the wipe depend on a chunk loading — so pressing panic offline, with
    // that chunk uncached, would have locked the vault and left the cache
    // sitting on disk. The one control that must work under adverse conditions
    // cannot be the one that needs the network.
    await offline.wipe();

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

    const { autoLockMs } = useLockSettings.getState();

    // `never`. No timer is set at all, rather than one set to a very large
    // number: an interval that merely looks infinite is a promise about the
    // engine's clock, and this one does not need to make it.
    if (!Number.isFinite(autoLockMs)) return;

    timer = setTimeout(() => {
      useVault.getState().lock(true);
    }, autoLockMs);
  };

  /**
   * The tab going away.
   *
   * Two different behaviours share this event. With lock-on-blur off it is
   * treated as activity and restarts the countdown, which is what it was doing
   * before. With it on, hiding the tab locks immediately — that is the whole
   * setting, and it is the one people want on a shared or borrowed machine
   * where the risk is somebody else's hands, not the passage of time.
   *
   * Only `hidden` locks. `visibilitychange` also fires on the way back, and
   * locking then would lock the vault at the moment its owner returned to it.
   */
  const onVisibility = (): void => {
    const { lockOnBlur } = useLockSettings.getState();

    if (lockOnBlur && document.visibilityState === 'hidden') {
      if (useVault.getState().state === 'unlocked') useVault.getState().lock(true);
      return;
    }

    reset();
  };

  const events = ['pointerdown', 'keydown'] as const;
  for (const event of events) {
    window.addEventListener(event, reset, { passive: true });
  }
  document.addEventListener('visibilitychange', onVisibility);

  // Subscribed to both stores: changing the timeout has to take effect on the
  // vault that is open now, not on the next one.
  const unsubscribeVault = useVault.subscribe(reset);
  const unsubscribeSettings = useLockSettings.subscribe(reset);
  reset();

  return () => {
    if (timer) clearTimeout(timer);
    for (const event of events) {
      window.removeEventListener(event, reset);
    }
    document.removeEventListener('visibilitychange', onVisibility);
    unsubscribeVault();
    unsubscribeSettings();
  };
}
