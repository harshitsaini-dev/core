'use client';

import { DEFAULT_ENVIRONMENTS } from '@core/shared';
import type { DecryptedEnvVar, DecryptedEnvironment, DecryptedProject } from '@core/shared';
import { create } from 'zustand';
import {
  newEnvId,
  pullEnv,
  pushEnv,
  toEnvironmentUpsert,
  toProjectUpsert,
  toVarUpsert,
} from './env-api';
import type { EnvOperation } from './env-api';
import { useVault } from './vault-store';

/**
 * Projects, environments and variables.
 *
 * Held in memory only, like the vault's decrypted items and for the same
 * reason. Unlike the vault there is no offline cache yet: the vault earned one
 * because a password is needed at the worst possible moment, on a phone with no
 * signal, and a `.env` file is needed at a desk. It is on the list rather than
 * assumed away.
 *
 * Every write is optimistic and pushed immediately. There is no outbox here
 * either — a failed push surfaces as an error the person can retry, rather than
 * queueing silently. That is a smaller promise than the vault makes and the
 * interface says so rather than implying otherwise.
 */

interface EnvState {
  readonly projects: readonly DecryptedProject[];
  readonly environments: readonly DecryptedEnvironment[];
  readonly vars: readonly DecryptedEnvVar[];
  readonly cursor: number;
  readonly loading: boolean;
  readonly error: string | null;

  load: () => Promise<void>;
  reset: () => void;

  createProject: (name: string) => Promise<string>;
  renameProject: (id: string, name: string) => Promise<void>;
  deleteProject: (id: string) => Promise<void>;

  createEnvironment: (projectId: string, name: string) => Promise<string>;
  deleteEnvironment: (id: string) => Promise<void>;
  duplicateEnvironment: (sourceId: string, name: string) => Promise<string>;

  saveVar: (
    environmentId: string,
    entry: { id?: string; key: string; value: string; note?: string | null },
  ) => Promise<void>;
  deleteVar: (id: string) => Promise<void>;
  importVars: (
    environmentId: string,
    incoming: readonly { key: string; value: string }[],
  ) => Promise<number>;
}

const EMPTY = {
  projects: [] as readonly DecryptedProject[],
  environments: [] as readonly DecryptedEnvironment[],
  vars: [] as readonly DecryptedEnvVar[],
  cursor: 0,
  loading: false,
  error: null,
};

export const useEnv = create<EnvState>((set, get) => ({
  ...EMPTY,

  reset: () => set({ ...EMPTY }),

  load: async () => {
    const keys = useVault.getState().keys;
    if (!keys) return;

    set({ loading: true, error: null });
    try {
      const result = await pullEnv(keys, 0);

      // Merged, never replaced. This pull starts when the screen mounts and
      // returns what the server had when the request left — so anything created
      // in the meantime is newer than the response, and assigning the response
      // wholesale deletes it from the screen while it sits on the server.
      //
      // That is not hypothetical: it is what made a project vanish the moment
      // it was created, because creating one is the first thing anybody does
      // here and the initial pull is still in flight when they do.
      set({
        projects: newest(get().projects, result.projects),
        environments: newest(get().environments, result.environments),
        vars: newest(get().vars, result.vars),
        cursor: result.cursor,
        loading: false,
      });
    } catch {
      set({ loading: false, error: 'Could not reach the server.' });
    }
  },

  createProject: async (name) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const id = newEnvId();
    const now = Date.now();

    // A project with no environments is a dead end — there is nowhere to put a
    // variable and nothing to look at. So it starts with the three every
    // project has, created in the same push so they cannot fail apart.
    const environments = DEFAULT_ENVIRONMENTS.map((environmentName, index) => ({
      id: newEnvId(),
      projectId: id,
      name: environmentName,
      sortOrder: index,
      createdAt: now,
      updatedAt: now,
    }));

    set({
      projects: [
        ...get().projects,
        { id, name, color: null, createdAt: now, updatedAt: now, deletedAt: null },
      ],
      environments: [...get().environments, ...environments],
    });

    await commit(set, get, [
      await toProjectUpsert(keys, { id, name }),
      ...(await Promise.all(environments.map((entry) => toEnvironmentUpsert(keys, entry)))),
    ]);

    return id;
  },

  renameProject: async (id, name) => {
    const keys = useVault.getState().keys;
    const project = get().projects.find((entry) => entry.id === id);
    if (!keys || !project) return;

    set({
      projects: get().projects.map((entry) => (entry.id === id ? { ...entry, name } : entry)),
    });

    await commit(set, get, [await toProjectUpsert(keys, { ...project, name })]);
  },

  deleteProject: async (id) => {
    const deletedAt = Date.now();
    set({
      projects: get().projects.map((entry) => (entry.id === id ? { ...entry, deletedAt } : entry)),
    });
    await commit(set, get, [{ op: 'project-delete', id }]);
  },

  createEnvironment: async (projectId, name) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const id = newEnvId();
    const now = Date.now();
    const sortOrder = get().environments.filter((entry) => entry.projectId === projectId).length;

    set({
      environments: [
        ...get().environments,
        { id, projectId, name, sortOrder, createdAt: now, updatedAt: now },
      ],
    });

    await commit(set, get, [await toEnvironmentUpsert(keys, { id, projectId, name, sortOrder })]);
    return id;
  },

  deleteEnvironment: async (id) => {
    // Hard, and it takes the variables with it. The interface confirms first;
    // there is no trash for environments yet.
    set({
      environments: get().environments.filter((entry) => entry.id !== id),
      vars: get().vars.filter((entry) => entry.environmentId !== id),
    });
    await commit(set, get, [{ op: 'environment-delete', id }]);
  },

  duplicateEnvironment: async (sourceId, name) => {
    const keys = useVault.getState().keys;
    const source = get().environments.find((entry) => entry.id === sourceId);
    if (!keys || !source) throw new Error('No such environment.');

    const id = await get().createEnvironment(source.projectId, name);

    // Copied with the values, which is the entire point: "staging is production
    // with three things changed" is how these are actually made, and an empty
    // copy would leave somebody retyping forty secrets by hand.
    const copies = get()
      .vars.filter((entry) => entry.environmentId === sourceId && entry.deletedAt === null)
      .map((entry) => ({
        id: newEnvId(),
        environmentId: id,
        key: entry.key,
        value: entry.value,
        note: entry.note,
        sortOrder: entry.sortOrder,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        deletedAt: null,
      }));

    set({ vars: [...get().vars, ...copies] });
    await commit(set, get, await Promise.all(copies.map((entry) => toVarUpsert(keys, entry))));

    return id;
  },

  saveVar: async (environmentId, entry) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const id = entry.id ?? newEnvId();
    const now = Date.now();
    const existing = get().vars.find((candidate) => candidate.id === id);

    const updated: DecryptedEnvVar = {
      id,
      environmentId,
      key: entry.key,
      value: entry.value,
      note: entry.note ?? existing?.note ?? null,
      sortOrder:
        existing?.sortOrder ?? get().vars.filter((v) => v.environmentId === environmentId).length,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      deletedAt: null,
    };

    set({
      vars: existing
        ? get().vars.map((candidate) => (candidate.id === id ? updated : candidate))
        : [...get().vars, updated],
    });

    await commit(set, get, [await toVarUpsert(keys, updated)]);
  },

  deleteVar: async (id) => {
    const deletedAt = Date.now();
    set({
      vars: get().vars.map((entry) => (entry.id === id ? { ...entry, deletedAt } : entry)),
    });
    await commit(set, get, [{ op: 'var-delete', id }]);
  },

  importVars: async (environmentId, incoming) => {
    const keys = useVault.getState().keys;
    if (!keys) throw new Error('The vault is locked.');

    const now = Date.now();
    const existing = get().vars.filter(
      (entry) => entry.environmentId === environmentId && entry.deletedAt === null,
    );
    const byKey = new Map(existing.map((entry) => [entry.key, entry]));

    const written: DecryptedEnvVar[] = [];

    for (const entry of incoming) {
      const match = byKey.get(entry.key);
      if (match && match.value === entry.value) continue;

      written.push({
        id: match?.id ?? newEnvId(),
        environmentId,
        key: entry.key,
        value: entry.value,
        note: match?.note ?? null,
        sortOrder: match?.sortOrder ?? existing.length + written.length,
        createdAt: match?.createdAt ?? now,
        updatedAt: now,
        deletedAt: null,
      });
    }

    if (written.length === 0) return 0;

    const touched = new Set(written.map((entry) => entry.id));
    set({
      vars: [
        ...get().vars.map((entry) => written.find((w) => w.id === entry.id) ?? entry),
        ...written.filter((entry) => !get().vars.some((v) => v.id === entry.id)),
      ].filter((entry, index, all) => all.findIndex((e) => e.id === entry.id) === index),
    });

    await commit(set, get, await Promise.all(written.map((entry) => toVarUpsert(keys, entry))));
    return touched.size;
  },
}));

/**
 * Combine what is here with what the server sent, keeping the newer of each.
 *
 * Compared on `updatedAt`, a browser clock against a server one. A skewed clock
 * resolves in favour of the local copy, which is the safe direction: it has
 * already been pushed, so the next pull agrees.
 */
function newest<T extends { id: string; updatedAt: number }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged = new Map(local.map((entry) => [entry.id, entry]));

  for (const entry of incoming) {
    const mine = merged.get(entry.id);
    if (!mine || entry.updatedAt >= mine.updatedAt) merged.set(entry.id, entry);
  }

  return [...merged.values()];
}

type Setter = (partial: Partial<EnvState>) => void;
type Getter = () => EnvState;

/**
 * Send a batch and report the outcome.
 *
 * One push per action, however many rows it touches. Importing a `.env` of
 * eighty variables is one request; doing it one at a time would be eighty
 * chances for the network to fail halfway through what the person considers a
 * single act.
 */
async function commit(set: Setter, get: Getter, operations: EnvOperation[]): Promise<void> {
  if (operations.length === 0) return;

  try {
    const cursor = await pushEnv(operations);
    set({ cursor: Math.max(get().cursor, cursor), error: null });
  } catch {
    set({ error: 'Not saved. Check your connection and try again.' });
  }
}

/** Projects that have not been deleted. */
export function activeProjects(projects: readonly DecryptedProject[]): DecryptedProject[] {
  return projects.filter((entry) => entry.deletedAt === null);
}

/** The environments of one project, in order. */
export function environmentsOf(
  environments: readonly DecryptedEnvironment[],
  projectId: string,
): DecryptedEnvironment[] {
  return environments
    .filter((entry) => entry.projectId === projectId)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
}

/** The live variables of one environment, in order. */
export function varsOf(vars: readonly DecryptedEnvVar[], environmentId: string): DecryptedEnvVar[] {
  return vars
    .filter((entry) => entry.environmentId === environmentId && entry.deletedAt === null)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}
