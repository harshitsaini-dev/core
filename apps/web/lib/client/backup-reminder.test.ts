import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BACKUP_INTERVAL_DAYS, backupState, lastBackupAt, recordBackup } from './backup-reminder';

/**
 * The backup reminder.
 *
 * Nothing here is scheduled — there is no server that knows whether a backup
 * was made, and there is not going to be one. So the only question these tests
 * can ask is whether the check made when the vault opens is right about the
 * date it has.
 */

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

/**
 * The unit suite runs in node, where there is no `localStorage`. A small stub
 * rather than pulling in a DOM: what is under test is the date arithmetic and
 * the refusal to trust a bad stored value, and neither of those is the
 * browser's behaviour.
 */
const store = new Map<string, string>();

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  },
});

describe('backupState', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('says nothing about an empty vault', () => {
    // The first thing after signing up should not be a warning about failing to
    // back up the nothing you have.
    expect(backupState(0, NOW)).toEqual({ due: false, days: null });
  });

  it('asks for a first backup once there is something to lose', () => {
    expect(backupState(3, NOW)).toEqual({ due: true, days: null });
  });

  it('goes quiet after a backup and comes back after the interval', () => {
    recordBackup(NOW);

    expect(backupState(3, NOW).due).toBe(false);
    expect(backupState(3, NOW + (BACKUP_INTERVAL_DAYS - 1) * DAY).due).toBe(false);
    expect(backupState(3, NOW + BACKUP_INTERVAL_DAYS * DAY).due).toBe(true);
  });

  it('counts the days so the message can be specific', () => {
    recordBackup(NOW);
    expect(backupState(3, NOW + 45 * DAY).days).toBe(45);
  });

  it('treats a stored date in the future as no backup at all', () => {
    // A clock that moved, or somebody editing localStorage. Trusting it means a
    // reminder that never appears again, which is the worse failure.
    localStorage.setItem('core.lastBackupAt', String(Date.now() + 10 * DAY));
    expect(lastBackupAt()).toBeNull();
    expect(backupState(3, NOW).due).toBe(true);
  });

  it('treats a corrupted date as no backup at all', () => {
    localStorage.setItem('core.lastBackupAt', 'yesterday');
    expect(lastBackupAt()).toBeNull();
    expect(backupState(3, NOW).due).toBe(true);
  });

  it('stores a date and nothing else', () => {
    // Whatever is in this key ends up readable by anything with access to the
    // device. It must never be more than a number.
    recordBackup(NOW);
    expect(localStorage.getItem('core.lastBackupAt')).toBe(String(NOW));
  });
});
