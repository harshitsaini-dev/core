'use client';

/**
 * Noticing that a vault has not been backed up in a long time.
 *
 * Called a reminder rather than a schedule, because nothing here is scheduled.
 * There is no server that knows what is in the vault and no push notification
 * this app is willing to send — the server holds ciphertext and could not tell
 * whether a backup was ever made. So this is checked when the vault is opened,
 * which is the only moment the app is running and the only moment the reminder
 * could be acted on anyway. The feature list said "scheduled"; the honest
 * version is what is written here.
 *
 * Only a date is stored, in `localStorage`, and only on the device that made
 * the backup. Putting it on the server would tell the one party this product
 * keeps data from exactly when somebody is carrying a copy of their vault
 * around — which is the week to try stealing it.
 *
 * The consequence is that this is per-device and per-browser, and a backup made
 * on a laptop does not quiet the reminder on a phone. That is the wrong answer
 * in a small way and the right one in a larger way, and it is the trade this
 * file exists to make.
 */

const KEY = 'core.lastBackupAt';

export const BACKUP_INTERVAL_DAYS = 30;

const DAY = 86_400_000;

/**
 * Anything on screen that depends on the date, told when it changes.
 *
 * Needed because the value lives in `localStorage` and nothing re-renders when
 * that is written. Without this the reminder stayed on screen after a backup
 * had just been taken, which is worse than not having a reminder: it says the
 * thing you did did not work.
 */
const listeners = new Set<() => void>();

export function subscribeToBackupDate(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function recordBackup(now = Date.now()): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(KEY, String(now));
  } catch {
    // Private browsing, a full quota, a locked-down profile. The backup itself
    // worked; failing to remember when is not worth an error next to it.
  }

  for (const listener of listeners) listener();
}

export function lastBackupAt(): number | null {
  if (typeof localStorage === 'undefined') return null;

  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return null;

    const parsed = Number(raw);
    // A value that is not a number, or is in the future, means somebody edited
    // it or the clock moved. Treated as no backup rather than trusted, because
    // the failure of trusting it is a reminder that never appears again.
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

export interface BackupState {
  readonly due: boolean;
  /** Whole days since the last backup, or null if there has never been one. */
  readonly days: number | null;
}

/**
 * Whether to say anything, and for how long it has been.
 *
 * An empty vault is never due. The first thing somebody sees after signing up
 * should not be a warning about failing to back up the nothing they have.
 */
export function backupState(itemCount: number, now = Date.now()): BackupState {
  if (itemCount === 0) return { due: false, days: null };

  const last = lastBackupAt();
  if (last === null) return { due: true, days: null };

  const days = Math.floor((now - last) / DAY);
  return { due: days >= BACKUP_INTERVAL_DAYS, days };
}
