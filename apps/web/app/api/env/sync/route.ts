import { environments, envVarVersions, envVars, projects } from '@core/db';
import { ENVELOPE_PATTERN, unsafeAsEncrypted } from '@core/shared';
import type { SyncedEnvVar, SyncedEnvironment, SyncedProject } from '@core/shared';
import { and, asc, eq, gt, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * Environment synchronisation.
 *
 * The same contract as the vault: opaque blobs in, opaque blobs out, and the
 * server has no idea what any of it means. It cannot read a project name, an
 * environment name, a variable key or a variable value.
 *
 * Ownership is the part that needs care here, and it is genuinely different
 * from the vault. A vault item carries the user id it belongs to. An
 * environment does not — it belongs to a project, and the project belongs to a
 * user. A variable is one step further out again.
 *
 * So every read is scoped by walking down from the projects this session owns,
 * and every write is checked against the same walk. Nothing takes an id from
 * the request and trusts it. Getting that wrong here would not leak a name — it
 * would hand somebody else's production secrets to whoever asked for them by
 * id.
 */

const envelope = z
  .string()
  .regex(ENVELOPE_PATTERN, 'expected a v1 ciphertext envelope')
  .max(200_000);

const projectUpsert = z.object({
  op: z.literal('project-upsert'),
  id: z.uuid(),
  nameEnc: envelope,
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .nullable()
    .default(null),
});

const projectDelete = z.object({ op: z.literal('project-delete'), id: z.uuid() });

const environmentUpsert = z.object({
  op: z.literal('environment-upsert'),
  id: z.uuid(),
  projectId: z.uuid(),
  nameEnc: envelope,
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});

const environmentDelete = z.object({ op: z.literal('environment-delete'), id: z.uuid() });

const varUpsert = z.object({
  op: z.literal('var-upsert'),
  id: z.uuid(),
  environmentId: z.uuid(),
  keyEnc: envelope,
  valueEnc: envelope,
  noteEnc: envelope.nullable().default(null),
  sortOrder: z.number().int().min(0).max(100_000).default(0),
});

const varDelete = z.object({ op: z.literal('var-delete'), id: z.uuid() });

/**
 * A previous value, kept so a change can be seen and undone.
 *
 * Sent by the client alongside the upsert that replaced it, rather than derived
 * here — the server cannot read either value and so cannot tell whether
 * anything changed.
 */
const varVersion = z.object({
  op: z.literal('var-version'),
  id: z.uuid(),
  envVarId: z.uuid(),
  keyEnc: envelope,
  valueEnc: envelope,
});

const pushSchema = z.object({
  operations: z
    .array(
      z.discriminatedUnion('op', [
        projectUpsert,
        projectDelete,
        environmentUpsert,
        environmentDelete,
        varUpsert,
        varDelete,
        varVersion,
      ]),
    )
    .max(1000),
});

/** A `.env` import of a thousand variables is a big one; this allows it. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

function projectToWire(row: typeof projects.$inferSelect): SyncedProject {
  return {
    id: row.id,
    nameEnc: row.nameEnc,
    color: row.color,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt?.getTime() ?? null,
  };
}

function environmentToWire(row: typeof environments.$inferSelect): SyncedEnvironment {
  return {
    id: row.id,
    projectId: row.projectId,
    nameEnc: row.nameEnc,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function varToWire(row: typeof envVars.$inferSelect): SyncedEnvVar {
  return {
    id: row.id,
    environmentId: row.environmentId,
    keyEnc: row.keyEnc,
    valueEnc: row.valueEnc,
    noteEnc: row.noteEnc,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt?.getTime() ?? null,
  };
}

/**
 * Every project, environment and variable this session can reach.
 *
 * Read in that order and each step scoped by the one before it, so an id in a
 * request can never widen what is returned.
 */
async function ownedIds(
  db: ReturnType<typeof getRequestContext>['db'],
  userId: string,
): Promise<{ projectIds: string[]; environmentIds: string[] }> {
  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, userId));

  const projectIds = projectRows.map((row) => row.id);
  if (projectIds.length === 0) return { projectIds, environmentIds: [] };

  const environmentRows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(inArray(environments.projectId, projectIds));

  return { projectIds, environmentIds: environmentRows.map((row) => row.id) };
}

/**
 * How many previous values to keep per variable.
 *
 * Not unlimited, and the reason is not storage. Every one of these is a
 * production secret that was live at some point, and a key rotated because it
 * leaked is exactly the one nobody wants kept forever. Ten is enough to undo a
 * mistake and short enough that history is not an archive.
 */
const MAX_VERSIONS = 10;

async function pruneVersions(
  db: ReturnType<typeof getRequestContext>['db'],
  envVarId: string,
): Promise<void> {
  const rows = await db
    .select({ id: envVarVersions.id })
    .from(envVarVersions)
    .where(eq(envVarVersions.envVarId, envVarId))
    .orderBy(asc(envVarVersions.createdAt));

  const excess = rows.slice(0, Math.max(0, rows.length - MAX_VERSIONS));
  if (excess.length === 0) return;

  await db.delete(envVarVersions).where(
    inArray(
      envVarVersions.id,
      excess.map((row) => row.id),
    ),
  );
}

export async function GET(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  const sinceParam = new URL(request.url).searchParams.get('since');
  const since = sinceParam === null ? 0 : Number(sinceParam);
  if (!Number.isFinite(since) || since < 0) return badRequest();

  const { db } = context;
  const after = new Date(since);
  const { projectIds, environmentIds } = await ownedIds(db, current.session.userId);

  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.userId, current.session.userId), gt(projects.updatedAt, after)));

  const environmentRows =
    projectIds.length === 0
      ? []
      : await db
          .select()
          .from(environments)
          .where(
            and(inArray(environments.projectId, projectIds), gt(environments.updatedAt, after)),
          );

  const varRows =
    environmentIds.length === 0
      ? []
      : await db
          .select()
          .from(envVars)
          .where(and(inArray(envVars.environmentId, environmentIds), gt(envVars.updatedAt, after)));

  const wire = {
    projects: projectRows.map(projectToWire),
    environments: environmentRows.map(environmentToWire),
    vars: varRows.map(varToWire),
  };

  // One cursor for all three, for the same reason the vault shares one between
  // items and folders: a client holding variables whose environment it has not
  // pulled has nowhere to put them.
  const cursor = [...wire.projects, ...wire.environments, ...wire.vars].reduce(
    (newest, row) => Math.max(newest, row.updatedAt),
    since,
  );

  return ok({ ...wire, cursor });
}

export async function POST(request: NextRequest): Promise<Response> {
  let context: ReturnType<typeof getRequestContext>;
  try {
    context = getRequestContext();
  } catch {
    return serverError();
  }

  const retryAfter = await checkLimit(
    request,
    context.kv,
    context.pepper,
    'sync',
    context.rateLimitTestMode,
  );
  if (retryAfter !== null) return tooManyRequests(retryAfter);

  const current = await requireSession(request, context);
  if (!current) return authFailure();

  let operations: z.infer<typeof pushSchema>['operations'];
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return badRequest();

    const parsed = pushSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return badRequest();
    operations = parsed.data.operations;
  } catch {
    return badRequest();
  }

  const { db } = context;
  const userId = current.session.userId;
  const now = new Date();

  const { projectIds, environmentIds } = await ownedIds(db, userId);
  const ownedProjects = new Set(projectIds);
  const ownedEnvironments = new Set(environmentIds);

  // Ids created within this batch count as owned for the operations that
  // follow. A new project, its environments and their variables arrive
  // together, and requiring a round trip between each would make creating a
  // project three requests that can fail apart from each other.
  const varsOwned = new Set(
    (
      await (environmentIds.length === 0
        ? Promise.resolve([])
        : db
            .select({ id: envVars.id })
            .from(envVars)
            .where(inArray(envVars.environmentId, environmentIds)))
    ).map((row) => row.id),
  );

  for (const operation of operations) {
    if (operation.op === 'project-upsert') {
      const values = { nameEnc: unsafeAsEncrypted(operation.nameEnc), color: operation.color };

      if (ownedProjects.has(operation.id)) {
        await db
          .update(projects)
          .set({ ...values, updatedAt: now })
          .where(and(eq(projects.id, operation.id), eq(projects.userId, userId)));
      } else {
        await db
          .insert(projects)
          .values({ id: operation.id, userId, ...values, createdAt: now, updatedAt: now })
          .onConflictDoNothing();
        ownedProjects.add(operation.id);
      }
      continue;
    }

    if (operation.op === 'project-delete') {
      if (!ownedProjects.has(operation.id)) continue;
      await db
        .update(projects)
        .set({ deletedAt: now, updatedAt: now })
        .where(and(eq(projects.id, operation.id), eq(projects.userId, userId)));
      continue;
    }

    if (operation.op === 'environment-upsert') {
      // The project has to be one of ours. Without this, an environment could
      // be attached to somebody else's project by id, and every variable under
      // it would then be readable by whoever attached it.
      if (!ownedProjects.has(operation.projectId)) continue;

      const values = {
        projectId: operation.projectId,
        nameEnc: unsafeAsEncrypted(operation.nameEnc),
        sortOrder: operation.sortOrder,
      };

      if (ownedEnvironments.has(operation.id)) {
        await db
          .update(environments)
          .set({ ...values, updatedAt: now })
          .where(eq(environments.id, operation.id));
      } else {
        await db
          .insert(environments)
          .values({ id: operation.id, ...values, createdAt: now, updatedAt: now })
          .onConflictDoNothing();
        ownedEnvironments.add(operation.id);
      }
      continue;
    }

    if (operation.op === 'environment-delete') {
      if (!ownedEnvironments.has(operation.id)) continue;
      // Hard, unlike everything else: an environment has no `deleted_at`, and
      // the cascade takes its variables with it. Trash for environments is on
      // the list; until it exists the interface confirms first.
      await db.delete(environments).where(eq(environments.id, operation.id));
      ownedEnvironments.delete(operation.id);
      continue;
    }

    if (operation.op === 'var-upsert') {
      if (!ownedEnvironments.has(operation.environmentId)) continue;

      const values = {
        environmentId: operation.environmentId,
        keyEnc: unsafeAsEncrypted(operation.keyEnc),
        valueEnc: unsafeAsEncrypted(operation.valueEnc),
        noteEnc: operation.noteEnc === null ? null : unsafeAsEncrypted(operation.noteEnc),
        sortOrder: operation.sortOrder,
      };

      if (varsOwned.has(operation.id)) {
        await db
          .update(envVars)
          .set({ ...values, updatedAt: now })
          .where(eq(envVars.id, operation.id));
      } else {
        await db
          .insert(envVars)
          .values({ id: operation.id, ...values, createdAt: now, updatedAt: now })
          .onConflictDoNothing();
        varsOwned.add(operation.id);
      }
      continue;
    }

    if (operation.op === 'var-version') {
      if (!varsOwned.has(operation.envVarId)) continue;

      await db
        .insert(envVarVersions)
        .values({
          id: operation.id,
          envVarId: operation.envVarId,
          keyEnc: unsafeAsEncrypted(operation.keyEnc),
          valueEnc: unsafeAsEncrypted(operation.valueEnc),
          createdAt: now,
        })
        .onConflictDoNothing();

      await pruneVersions(db, operation.envVarId);
      continue;
    }

    if (!varsOwned.has(operation.id)) continue;
    await db
      .update(envVars)
      .set({ deletedAt: now, updatedAt: now })
      .where(eq(envVars.id, operation.id));
  }

  return ok({ status: 'ok', cursor: now.getTime() });
}
