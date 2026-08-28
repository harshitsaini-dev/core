import { z } from 'zod';

/**
 * The backup format.
 *
 * A vault nobody can get their data out of is a vault nobody should put data
 * into. This is the way out — and, more importantly, the way back in when the
 * account is gone, the service is gone, or the person simply wants a copy on a
 * disk they own.
 *
 * ## What is in it
 *
 * Ciphertext, exactly as it is stored. Nothing is decrypted to make a backup
 * and nothing is re-encrypted: an export is a copy of the blobs plus the
 * material needed to derive the key that opens them.
 *
 * That material is the KDF salt, the KDF parameters and the wrapped Account
 * Key — the same three things `prelogin` hands to anyone who asks, and the same
 * three the offline cache already keeps on the device. Including them is what
 * makes the file restorable with a master password alone, which is the only
 * kind of backup worth having: one that needs the running service to read is
 * not a backup of anything.
 *
 * ## What that costs, said plainly
 *
 * A backup file is offline-attackable. Somebody who takes it can guess master
 * passwords against it at their own pace with no rate limit and no server
 * involved. That is inherent — it is the same trade the Emergency Kit and the
 * offline cache already make — and the defence is the same: Argon2id, tuned so
 * each guess costs real time and memory.
 *
 * So the file is worth roughly what the master password is worth. The interface
 * says so at the point of download rather than in a footnote.
 */

export const BACKUP_FORMAT = 'core.backup.v1';

const envelope = z.string().min(1);

export const backupSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  /** When the export was taken, by the exporting device's clock. */
  createdAt: z.number().int().nonnegative(),

  /**
   * How to get from a master password to the Account Key.
   *
   * Public by design — `prelogin` serves the salt and parameters to anyone who
   * asks, and the wrapped key is useless without the password.
   */
  kdf: z.object({
    salt: z.string().min(1),
    params: z.object({
      algorithm: z.literal('argon2id'),
      memoryKiB: z.number().int().positive(),
      iterations: z.number().int().positive(),
      parallelism: z.number().int().positive(),
    }),
  }),
  accountKeyWrapped: envelope,

  items: z.array(
    z.object({
      id: z.uuid(),
      type: z.enum(['login', 'note', 'card', 'identity', 'ssh']),
      dataEnc: envelope,
      folderId: z.uuid().nullable(),
      favorite: z.boolean(),
      createdAt: z.number().int().nonnegative(),
      updatedAt: z.number().int().nonnegative(),
      deletedAt: z.number().int().nonnegative().nullable(),
    }),
  ),

  folders: z.array(
    z.object({
      id: z.uuid(),
      parentId: z.uuid().nullable(),
      nameEnc: envelope,
      color: z.string().nullable(),
      sortOrder: z.number().int(),
    }),
  ),

  projects: z.array(
    z.object({
      id: z.uuid(),
      nameEnc: envelope,
      color: z.string().nullable(),
    }),
  ),

  environments: z.array(
    z.object({
      id: z.uuid(),
      projectId: z.uuid(),
      nameEnc: envelope,
      sortOrder: z.number().int(),
    }),
  ),

  vars: z.array(
    z.object({
      id: z.uuid(),
      environmentId: z.uuid(),
      keyEnc: envelope,
      valueEnc: envelope,
      noteEnc: envelope.nullable(),
      sortOrder: z.number().int(),
    }),
  ),
});

export type Backup = z.infer<typeof backupSchema>;

/**
 * Read a file that claims to be a backup.
 *
 * Returns the reason rather than throwing, because every one of these is
 * something the person needs told: a file from a newer version, a file that is
 * not a backup at all, a file that has been truncated by whatever copied it.
 * "Import failed" helps nobody standing in front of a vault they cannot open.
 */
export function readBackup(text: string): { backup: Backup } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'That file is not a Core backup — it is not even JSON.' };
  }

  if (typeof parsed === 'object' && parsed !== null && 'format' in parsed) {
    const format = (parsed as { format: unknown }).format;
    if (typeof format === 'string' && format !== BACKUP_FORMAT) {
      return {
        error: `That backup is in format ${format}, and this version reads ${BACKUP_FORMAT}.`,
      };
    }
  }

  const result = backupSchema.safeParse(parsed);
  if (!result.success) {
    return { error: 'That file is a Core backup but part of it is missing or damaged.' };
  }

  return { backup: result.data };
}

/** How many things a backup holds, for a confirmation that names numbers. */
export function backupContents(backup: Backup): {
  items: number;
  folders: number;
  projects: number;
  vars: number;
} {
  return {
    // Deleted items are counted out. They are in the file — trash is restorable
    // too — but "412 items" when 300 of them are in the bin is a lie by
    // arithmetic.
    items: backup.items.filter((entry) => entry.deletedAt === null).length,
    folders: backup.folders.length,
    projects: backup.projects.length,
    vars: backup.vars.length,
  };
}

/** The filename an export gets. Dated, because people keep more than one. */
export function backupFilename(createdAt: number): string {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  return `core-backup-${date}.json`;
}
