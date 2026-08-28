'use client';

import { create } from 'zustand';

/**
 * When the vault locks itself.
 *
 * Kept apart from the vault store on purpose. That store holds the Account Keys
 * and states as its first rule that it must never be given persistence
 * middleware, because persisting it would write the keys that open the entire
 * vault to disk in the clear. These two preferences do need to be persisted, so
 * they live here instead of becoming the reason somebody reaches for `persist`
 * on the store next door.
 *
 * Neither value is a secret. "This person locks after a minute" says nothing
 * about what is in the vault, and re-choosing it every visit is the kind of
 * friction that makes people turn a security control off.
 */

/** The choices, in the order they are offered. */
export const AUTO_LOCK_CHOICES = [
  { ms: 60_000, label: '1 minute' },
  { ms: 300_000, label: '5 minutes' },
  { ms: 900_000, label: '15 minutes' },
  { ms: Number.POSITIVE_INFINITY, label: 'never' },
] as const;

export const DEFAULT_AUTO_LOCK_MS = 300_000;

const TIMEOUT_KEY = 'core.auto-lock-ms';
const BLUR_KEY = 'core.lock-on-blur';

/**
 * Read a stored timeout, or the default.
 *
 * Anything unrecognised falls back to the default rather than to `never`. A
 * corrupted key, a value from an older build, a half-written entry — none of
 * those are a request to stop locking, and reading them as one would turn a
 * storage glitch into a vault left open on a shared machine.
 */
function readTimeout(): number {
  if (typeof localStorage === 'undefined') return DEFAULT_AUTO_LOCK_MS;

  const stored = localStorage.getItem(TIMEOUT_KEY);
  if (stored === 'never') return Number.POSITIVE_INFINITY;

  const ms = Number(stored);
  return AUTO_LOCK_CHOICES.some((choice) => choice.ms === ms) ? ms : DEFAULT_AUTO_LOCK_MS;
}

function readLockOnBlur(): boolean {
  if (typeof localStorage === 'undefined') return false;
  return localStorage.getItem(BLUR_KEY) === 'on';
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode, a full quota, a browser with storage switched off. The
    // preference is worth remembering and not worth failing over — the vault
    // still locks, on whatever this session was told.
  }
}

interface LockSettings {
  /** Milliseconds of inactivity before an automatic lock. */
  readonly autoLockMs: number;
  /** Lock the moment the tab is hidden, without waiting for the timer. */
  readonly lockOnBlur: boolean;

  setAutoLockMs: (ms: number) => void;
  setLockOnBlur: (on: boolean) => void;
  /** Read the stored preferences. Called after mount, never during render. */
  hydrate: () => void;
}

export const useLockSettings = create<LockSettings>((set) => ({
  // Start on the defaults rather than on the stored values: reading
  // `localStorage` during the first render disagrees with what the server
  // rendered, and React replaces the whole tree when it notices.
  autoLockMs: DEFAULT_AUTO_LOCK_MS,
  lockOnBlur: false,

  setAutoLockMs: (ms) => {
    set({ autoLockMs: ms });
    write(TIMEOUT_KEY, Number.isFinite(ms) ? String(ms) : 'never');
  },

  setLockOnBlur: (on) => {
    set({ lockOnBlur: on });
    write(BLUR_KEY, on ? 'on' : 'off');
  },

  hydrate: () => set({ autoLockMs: readTimeout(), lockOnBlur: readLockOnBlur() }),
}));
