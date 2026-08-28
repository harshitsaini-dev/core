import { decryptString, encryptString } from '@core/crypto';
import type { AccountKeys } from '@core/crypto';
import type {
  DecryptedEnvVar,
  DecryptedEnvironment,
  DecryptedProject,
  SyncedEnvVar,
  SyncedEnvironment,
  SyncedProject,
} from '@core/shared';

/**
 * Reading and writing environments.
 *
 * The same boundary as the vault: plaintext on this side, ciphertext on the
 * other. Both halves of a variable cross it — the key as well as the value —
 * because a list of key names is a list of what a project integrates with.
 */

interface SyncResponse {
  projects: SyncedProject[];
  environments: SyncedEnvironment[];
  vars: SyncedEnvVar[];
  cursor: number;
}

export interface EnvPullResult {
  readonly projects: DecryptedProject[];
  readonly environments: DecryptedEnvironment[];
  readonly vars: DecryptedEnvVar[];
  readonly cursor: number;
}

/**
 * Anything that will not decrypt is shown under a placeholder rather than
 * dropped.
 *
 * A missing variable is worse than an unreadable one: a `.env` exported with a
 * row silently absent produces a deploy that fails somewhere else entirely,
 * hours later, for reasons nobody connects back to here.
 */
async function open(key: CryptoKey, envelope: string, fallback: string): Promise<string> {
  try {
    return await decryptString(key, envelope);
  } catch {
    return fallback;
  }
}

export async function decryptProjects(
  keys: AccountKeys,
  rows: readonly SyncedProject[],
): Promise<DecryptedProject[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      name: await open(keys.dataKey, row.nameEnc, 'Unreadable project'),
      color: row.color,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    })),
  );
}

export async function decryptEnvironments(
  keys: AccountKeys,
  rows: readonly SyncedEnvironment[],
): Promise<DecryptedEnvironment[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      projectId: row.projectId,
      name: await open(keys.dataKey, row.nameEnc, 'unreadable'),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })),
  );
}

export async function decryptVars(
  keys: AccountKeys,
  rows: readonly SyncedEnvVar[],
): Promise<DecryptedEnvVar[]> {
  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      environmentId: row.environmentId,
      key: await open(keys.dataKey, row.keyEnc, 'UNREADABLE'),
      value: await open(keys.dataKey, row.valueEnc, ''),
      note: row.noteEnc === null ? null : await open(keys.dataKey, row.noteEnc, ''),
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    })),
  );
}

export type EnvOperation =
  | { op: 'project-upsert'; id: string; nameEnc: string; color: string | null }
  | { op: 'project-delete'; id: string }
  | {
      op: 'environment-upsert';
      id: string;
      projectId: string;
      nameEnc: string;
      sortOrder: number;
    }
  | { op: 'environment-delete'; id: string }
  | {
      op: 'var-upsert';
      id: string;
      environmentId: string;
      keyEnc: string;
      valueEnc: string;
      noteEnc: string | null;
      sortOrder: number;
    }
  | { op: 'var-delete'; id: string }
  | {
      op: 'var-version';
      id: string;
      envVarId: string;
      keyEnc: string;
      valueEnc: string;
    };

export async function toProjectUpsert(
  keys: AccountKeys,
  project: { id: string; name: string; color?: string | null },
): Promise<EnvOperation> {
  return {
    op: 'project-upsert',
    id: project.id,
    nameEnc: await encryptString(keys.dataKey, project.name),
    color: project.color ?? null,
  };
}

export async function toEnvironmentUpsert(
  keys: AccountKeys,
  environment: { id: string; projectId: string; name: string; sortOrder?: number },
): Promise<EnvOperation> {
  return {
    op: 'environment-upsert',
    id: environment.id,
    projectId: environment.projectId,
    nameEnc: await encryptString(keys.dataKey, environment.name),
    sortOrder: environment.sortOrder ?? 0,
  };
}

export async function toVarUpsert(
  keys: AccountKeys,
  variable: {
    id: string;
    environmentId: string;
    key: string;
    value: string;
    note?: string | null;
    sortOrder?: number;
  },
): Promise<EnvOperation> {
  return {
    op: 'var-upsert',
    id: variable.id,
    environmentId: variable.environmentId,
    keyEnc: await encryptString(keys.dataKey, variable.key),
    valueEnc: await encryptString(keys.dataKey, variable.value),
    noteEnc: variable.note ? await encryptString(keys.dataKey, variable.note) : null,
    sortOrder: variable.sortOrder ?? 0,
  };
}

export async function pullEnv(keys: AccountKeys, cursor = 0): Promise<EnvPullResult> {
  const response = await fetch(`/api/env/sync?since=${cursor}`, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('Could not reach the server.');

  const body = (await response.json()) as SyncResponse;

  return {
    projects: await decryptProjects(keys, body.projects),
    environments: await decryptEnvironments(keys, body.environments),
    vars: await decryptVars(keys, body.vars),
    cursor: body.cursor,
  };
}

export async function pushEnv(operations: readonly EnvOperation[]): Promise<number> {
  if (operations.length === 0) return 0;

  const response = await fetch('/api/env/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ operations }),
  });

  if (!response.ok) throw new Error('Could not save.');

  const body = (await response.json()) as { cursor: number };
  return body.cursor;
}

export interface EnvVarVersion {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  readonly createdAt: number;
}

/** The value a variable had before a change, ready to store. */
export async function toVersion(
  keys: AccountKeys,
  previous: { id: string; key: string; value: string },
): Promise<EnvOperation> {
  return {
    op: 'var-version',
    id: crypto.randomUUID(),
    envVarId: previous.id,
    keyEnc: await encryptString(keys.dataKey, previous.key),
    valueEnc: await encryptString(keys.dataKey, previous.value),
  };
}

/**
 * The previous values of one variable.
 *
 * Fetched on demand rather than carried by every sync: each of these is a
 * secret in its own right, and a project of forty variables would otherwise
 * ship four hundred blobs nobody asked to see.
 */
export async function fetchHistory(keys: AccountKeys, envVarId: string): Promise<EnvVarVersion[]> {
  const response = await fetch(`/api/env/history?varId=${encodeURIComponent(envVarId)}`, {
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error('Could not load the history.');

  const body = (await response.json()) as {
    versions: { id: string; keyEnc: string; valueEnc: string; createdAt: number }[];
  };

  return Promise.all(
    body.versions.map(async (row) => ({
      id: row.id,
      key: await open(keys.dataKey, row.keyEnc, 'UNREADABLE'),
      value: await open(keys.dataKey, row.valueEnc, ''),
      createdAt: row.createdAt,
    })),
  );
}

export function newEnvId(): string {
  return crypto.randomUUID();
}
