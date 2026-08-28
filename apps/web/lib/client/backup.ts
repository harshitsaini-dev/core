'use client';

import {
  base64UrlToBytes,
  decryptJson,
  decryptString,
  deriveKeys,
  encryptJson,
  encryptString,
  unwrapAccountKeys,
} from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import { BACKUP_FORMAT, vaultItemDataSchema } from '@core/shared';
import type { Backup, KdfParams } from '@core/shared';
import * as offline from './offline-db';
import type { EnvOperation } from './env-api';
import { pushEnv } from './env-api';
import { push } from './vault-api';
import type { Operation } from './vault-api';

/**
 * Taking a backup, and putting one back.
 *
 * ## Taking one
 *
 * The ciphertext is copied, not re-encrypted. An export is the blobs exactly as
 * the server holds them plus the three things needed to derive the key that
 * opens them — the salt, the KDF parameters and the wrapped Account Key, all of
 * which `prelogin` already serves to anyone who asks.
 *
 * Read from the server rather than the local cache, deliberately. A backup of
 * what one device happens to have cached is a backup of an unknown subset; a
 * backup should be of the vault.
 *
 * ## Putting one back
 *
 * Restoring decrypts with the backup's own key and re-encrypts under the
 * current account's. That is what makes it a disaster-recovery path rather than
 * a copy-paste: the account it goes into does not have to be the account it came
 * from, which is the entire point on the day the original account is gone.
 *
 * It never deletes. A restore adds what is missing and updates what it can
 * match by id, and anything in the vault that the backup does not mention is
 * left exactly where it is. "Restore the two items I lost" must not mean
 * "replace everything with a file from March".
 *
 * ## Why the ids are rewritten
 *
 * An id in a backup belongs to the account the backup came from, and ids are
 * globally unique keys rather than per-account ones. Restoring into a different
 * account while the original rows still exist means every insert collides with
 * a row somebody else owns — and the server, correctly, refuses to touch it and
 * says nothing. The restore then reports success and does nothing at all, which
 * is the worst outcome available on the one day this feature matters.
 *
 * So an id is kept only when this account already has it, which is the
 * same-account case and the one where updating in place is what somebody wants.
 * Everything else is given a fresh id, and every reference between the rows —
 * an item's folder, an environment's project, a variable's environment, an
 * item's linked project — is rewritten to match.
 */

interface RawSync {
  items: {
    id: string;
    type: 'login' | 'note' | 'card' | 'identity' | 'ssh';
    dataEnc: string;
    folderId: string | null;
    favorite: boolean;
    createdAt: number;
    updatedAt: number;
    deletedAt: number | null;
  }[];
  folders: {
    id: string;
    parentId: string | null;
    nameEnc: string;
    color: string | null;
    sortOrder: number;
  }[];
}

interface RawEnv {
  projects: { id: string; nameEnc: string; color: string | null }[];
  environments: { id: string; projectId: string; nameEnc: string; sortOrder: number }[];
  vars: {
    id: string;
    environmentId: string;
    keyEnc: string;
    valueEnc: string;
    noteEnc: string | null;
    sortOrder: number;
  }[];
}

export class BackupUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupUnavailable';
  }
}

/** Everything, as ciphertext, with the material needed to open it. */
export async function buildBackup(now = Date.now()): Promise<Backup> {
  const unlock = await offline.readUnlockMaterial();
  if (!unlock) {
    // Without the salt, the parameters and the wrapped key, the file would only
    // be readable by an account that already exists — which is not a backup.
    throw new BackupUnavailable(
      'This device has not stored the material a backup needs. Sign in again and retry.',
    );
  }

  const [vault, env] = await Promise.all([
    fetch('/api/vault/sync?since=0', { credentials: 'same-origin' }),
    fetch('/api/env/sync?since=0', { credentials: 'same-origin' }),
  ]);

  if (!vault.ok || !env.ok) throw new BackupUnavailable('Could not read the vault to back it up.');

  const vaultBody = (await vault.json()) as RawSync;
  const envBody = (await env.json()) as RawEnv;

  return {
    format: BACKUP_FORMAT,
    createdAt: now,
    kdf: { salt: unlock.kdfSalt, params: unlock.kdfParams as Backup['kdf']['params'] },
    accountKeyWrapped: unlock.accountKeyWrapped,
    items: vaultBody.items,
    folders: vaultBody.folders,
    projects: envBody.projects,
    environments: envBody.environments,
    vars: envBody.vars,
  };
}

export class BackupPasswordWrong extends Error {
  constructor() {
    super('That master password does not open this backup.');
    this.name = 'BackupPasswordWrong';
  }
}

export interface RestoreResult {
  readonly items: number;
  readonly folders: number;
  readonly projects: number;
  readonly environments: number;
  readonly vars: number;
  /** Rows whose ciphertext would not open. Reported, never silently dropped. */
  readonly unreadable: number;
}

/**
 * Open a backup with the password it was made under, and write it into the
 * account that is currently unlocked.
 */
export async function restoreBackup(
  backup: Backup,
  masterPassword: string,
  current: AccountKeys,
  /** Ids this account already has. Anything else in the file is given a new one. */
  known: ReadonlySet<string> = new Set(),
): Promise<RestoreResult> {
  const { masterKey } = await deriveKeys(
    masterPassword,
    base64UrlToBytes(backup.kdf.salt),
    backup.kdf.params as KdfParams,
  );

  let source: AccountKeys;
  try {
    source = await unwrapAccountKeys(masterKey, backup.accountKeyWrapped);
  } catch {
    // The only failure this path can have that is the person's to fix.
    throw new BackupPasswordWrong();
  }

  let unreadable = 0;

  const remapped = new Map<string, string>();
  const idFor = (original: string): string => {
    if (known.has(original)) return original;

    const existing = remapped.get(original);
    if (existing) return existing;

    const fresh = crypto.randomUUID();
    remapped.set(original, fresh);
    return fresh;
  };

  /** Decrypt under the backup's key, re-encrypt under this account's. */
  async function recryptString(envelope: string): Promise<string | null> {
    try {
      return await encryptString(current.dataKey, await decryptString(source.dataKey, envelope));
    } catch {
      unreadable += 1;
      return null;
    }
  }

  const folderOps: Operation[] = [];
  for (const folder of backup.folders) {
    const nameEnc = await recryptString(folder.nameEnc);
    if (!nameEnc) continue;

    folderOps.push({
      op: 'folder-upsert',
      id: idFor(folder.id),
      nameEnc,
      parentId: folder.parentId === null ? null : idFor(folder.parentId),
      color: folder.color,
      sortOrder: folder.sortOrder,
    });
  }

  const itemOps: Operation[] = [];
  for (const entry of backup.items) {
    // Trash is restored as trash. Somebody who deleted something and then had
    // to restore a backup did not ask for it back.
    if (entry.deletedAt !== null) continue;

    try {
      const data = vaultItemDataSchema.parse(
        await decryptJson<unknown>(source.dataKey, entry.dataEnc),
      );

      // A link points at a project, which is being renumbered too.
      const linked = data.fields.linkedProjectId;
      const relinked =
        linked === undefined
          ? data
          : { ...data, fields: { ...data.fields, linkedProjectId: idFor(linked) } };

      itemOps.push({
        op: 'upsert',
        id: idFor(entry.id),
        type: entry.type,
        dataEnc: await encryptJson(current.dataKey, relinked as typeof data),
        folderId: entry.folderId === null ? null : idFor(entry.folderId),
        urlBlindIndex: null,
        favorite: entry.favorite,
        lastUsedAt: null,
      });
    } catch {
      unreadable += 1;
    }
  }

  // Folders before items, so an item never lands pointing at a folder that is
  // not there yet and quietly appears unfiled.
  if (folderOps.length > 0) await push(folderOps);
  if (itemOps.length > 0) await push(itemOps);

  const envOps: EnvOperation[] = [];

  for (const project of backup.projects) {
    const nameEnc = await recryptString(project.nameEnc);
    if (nameEnc) {
      envOps.push({ op: 'project-upsert', id: idFor(project.id), nameEnc, color: project.color });
    }
  }

  for (const environment of backup.environments) {
    const nameEnc = await recryptString(environment.nameEnc);
    if (nameEnc) {
      envOps.push({
        op: 'environment-upsert',
        id: idFor(environment.id),
        projectId: idFor(environment.projectId),
        nameEnc,
        sortOrder: environment.sortOrder,
      });
    }
  }

  for (const variable of backup.vars) {
    const keyEnc = await recryptString(variable.keyEnc);
    const valueEnc = await recryptString(variable.valueEnc);
    if (!keyEnc || !valueEnc) continue;

    envOps.push({
      op: 'var-upsert',
      id: idFor(variable.id),
      environmentId: idFor(variable.environmentId),
      keyEnc,
      valueEnc,
      noteEnc: variable.noteEnc ? await recryptString(variable.noteEnc) : null,
      sortOrder: variable.sortOrder,
    });
  }

  // One push, in this order, for the same reason as above: the server checks
  // ownership by walking down from projects, and an environment sent before its
  // project would be refused.
  if (envOps.length > 0) await pushEnv(envOps);

  return {
    items: itemOps.length,
    folders: folderOps.length,
    projects: backup.projects.length,
    environments: backup.environments.length,
    vars: backup.vars.length,
    unreadable,
  };
}
