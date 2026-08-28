import { environments, envVarVersions, envVars, projects } from '@core/db';
import { desc, eq, inArray } from 'drizzle-orm';
import type { NextRequest } from 'next/server';
import { getRequestContext } from '@/lib/server/context';
import { checkLimit } from '@/lib/server/rate-limit';
import { authFailure, badRequest, ok, serverError, tooManyRequests } from '@/lib/server/responses';
import { requireSession } from '@/lib/server/session-guard';

/**
 * The previous values of one variable.
 *
 * Separate from the sync endpoint on purpose. Every old value is a secret in
 * its own right, and shipping all of them to every client on every refresh
 * would mean a project of forty variables carrying four hundred blobs it will
 * almost certainly never show. This is asked for when somebody opens the
 * history of one variable, and answers only that.
 *
 * Ownership is walked the same way as the sync route: down from the projects
 * this session owns. A variable id in the query proves nothing about who it
 * belongs to.
 */
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

  const envVarId = new URL(request.url).searchParams.get('varId');
  if (!envVarId) return badRequest();

  const { db } = context;

  const projectRows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.userId, current.session.userId));

  const projectIds = projectRows.map((row) => row.id);
  if (projectIds.length === 0) return ok({ versions: [] });

  const environmentRows = await db
    .select({ id: environments.id })
    .from(environments)
    .where(inArray(environments.projectId, projectIds));

  const environmentIds = environmentRows.map((row) => row.id);
  if (environmentIds.length === 0) return ok({ versions: [] });

  const owned = await db
    .select({ id: envVars.id })
    .from(envVars)
    .where(inArray(envVars.environmentId, environmentIds));

  // An empty answer rather than a rejection: a 404 here would confirm that
  // somebody else's variable id is a real one.
  if (!owned.some((row) => row.id === envVarId)) return ok({ versions: [] });

  const rows = await db
    .select()
    .from(envVarVersions)
    .where(eq(envVarVersions.envVarId, envVarId))
    .orderBy(desc(envVarVersions.createdAt));

  return ok({
    versions: rows.map((row) => ({
      id: row.id,
      keyEnc: row.keyEnc,
      valueEnc: row.valueEnc,
      createdAt: row.createdAt.getTime(),
    })),
  });
}
