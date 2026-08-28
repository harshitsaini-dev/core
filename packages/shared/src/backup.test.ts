import { describe, expect, it } from 'vitest';
import { BACKUP_FORMAT, backupContents, backupFilename, backupSchema, readBackup } from './backup';
import type { Backup } from './backup';

/**
 * The backup format.
 *
 * A vault nobody can get their data out of is a vault nobody should put data
 * into, so the reading half is the half that matters: every way a file can be
 * wrong is something the person in front of it needs told, in words, while they
 * are standing there unable to open their vault.
 */

function backup(overrides: Partial<Backup> = {}): Backup {
  return {
    format: BACKUP_FORMAT,
    createdAt: 1_700_000_000_000,
    kdf: {
      salt: 'a-salt',
      params: { algorithm: 'argon2id', memoryKiB: 65_536, iterations: 12, parallelism: 1 },
    },
    accountKeyWrapped: 'v1.iv.ct',
    items: [],
    folders: [],
    projects: [],
    environments: [],
    vars: [],
    ...overrides,
  };
}

const item = (id: string, deletedAt: number | null = null) => ({
  id,
  type: 'login' as const,
  dataEnc: 'v1.iv.ct',
  folderId: null,
  favorite: false,
  createdAt: 0,
  updatedAt: 0,
  deletedAt,
});

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('readBackup', () => {
  it('reads a file it wrote', () => {
    const result = readBackup(JSON.stringify(backup()));
    expect('backup' in result).toBe(true);
  });

  it('says a file is not JSON, rather than "import failed"', () => {
    const result = readBackup('this is not a backup');
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain('not even JSON');
  });

  it('names the format it found and the one it reads', () => {
    // A file from a later version is the case where a vague message costs the
    // most: the fix is to use a newer Core, and nothing else will suggest it.
    const future = JSON.stringify({ ...backup(), format: 'core.backup.v9' });
    const result = readBackup(future);

    expect('error' in result && result.error).toContain('core.backup.v9');
    expect('error' in result && result.error).toContain(BACKUP_FORMAT);
  });

  it('says a backup is damaged rather than silently dropping what is missing', () => {
    const { items, ...withoutItems } = backup();
    expect(items).toEqual([]);

    const result = readBackup(JSON.stringify(withoutItems));
    expect('error' in result && result.error).toContain('damaged');
  });

  it('refuses ciphertext that is empty', () => {
    // An empty envelope would restore as an item that cannot be opened, which
    // is worse than one that never arrived.
    const broken = backup({ items: [{ ...item(UUID_A), dataEnc: '' }] });
    expect(backupSchema.safeParse(broken).success).toBe(false);
  });

  it('round-trips a backup with contents', () => {
    const full = backup({
      items: [item(UUID_A), item(UUID_B, 5)],
      folders: [{ id: UUID_A, parentId: null, nameEnc: 'v1.a.b', color: null, sortOrder: 0 }],
    });

    const result = readBackup(JSON.stringify(full));
    expect('backup' in result && result.backup).toEqual(full);
  });
});

describe('backupContents', () => {
  it('counts what is in the vault, not what is in the bin', () => {
    // "412 items" when 300 of them are deleted is a lie by arithmetic.
    const counts = backupContents(backup({ items: [item(UUID_A), item(UUID_B, 1)] }));
    expect(counts.items).toBe(1);
  });

  it('counts nothing for an empty backup', () => {
    expect(backupContents(backup())).toEqual({ items: 0, folders: 0, projects: 0, vars: 0 });
  });
});

describe('backupFilename', () => {
  it('dates the file, because people keep more than one', () => {
    expect(backupFilename(Date.UTC(2026, 7, 28))).toBe('core-backup-2026-08-28.json');
  });
});
