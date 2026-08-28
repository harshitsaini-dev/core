import { encryptString } from '@core/crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loginWith, register } from '../helpers/account';
import type { BuiltAccount } from '../helpers/account';

/**
 * The environment sync endpoint.
 *
 * Mostly about ownership, because that is what is different here. A vault item
 * carries the user it belongs to; an environment belongs to a project and a
 * variable belongs to an environment, so the server has to walk down from the
 * projects a session owns rather than trust an id in the request.
 *
 * Getting that wrong would not leak a name. It would hand somebody else's
 * production secrets to whoever asked for them by id.
 */

async function signedIn(request: APIRequestContext, label: string): Promise<BuiltAccount> {
  const account = await register(request, label);
  const response = await loginWith(request, account.payload.email, account.payload.authKey);
  expect(response.status()).toBe(200);
  return account;
}

async function push(request: APIRequestContext, operations: unknown[]) {
  return request.post('/api/env/sync', { data: { operations } });
}

interface SyncBody {
  projects: { id: string; nameEnc: string; deletedAt: number | null }[];
  environments: { id: string; projectId: string }[];
  vars: { id: string; environmentId: string; keyEnc: string; valueEnc: string }[];
  cursor: number;
}

async function pull(request: APIRequestContext, since = 0): Promise<SyncBody> {
  const response = await request.get(`/api/env/sync?since=${since}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as SyncBody;
}

/** A project with one environment and one variable, all in one push. */
async function seed(request: APIRequestContext, account: BuiltAccount, label: string) {
  const projectId = crypto.randomUUID();
  const environmentId = crypto.randomUUID();
  const varId = crypto.randomUUID();
  const key = account.keys.dataKey;

  const response = await push(request, [
    {
      op: 'project-upsert',
      id: projectId,
      nameEnc: await encryptString(key, `${label}-project`),
      color: '#00FF41',
    },
    {
      op: 'environment-upsert',
      id: environmentId,
      projectId,
      nameEnc: await encryptString(key, 'production'),
      sortOrder: 0,
    },
    {
      op: 'var-upsert',
      id: varId,
      environmentId,
      keyEnc: await encryptString(key, 'STRIPE_SECRET_KEY'),
      valueEnc: await encryptString(key, `sk_live_${label}`),
      noteEnc: null,
      sortOrder: 0,
    },
  ]);

  expect(response.status()).toBe(200);
  return { projectId, environmentId, varId };
}

test.describe('env sync', () => {
  test('stores a project, an environment and a variable in one push', async ({ request }) => {
    // One request, because a project and its first environment are created
    // together and three round trips can fail apart from each other.
    const account = await signedIn(request, 'env');
    const ids = await seed(request, account, 'env');

    const body = await pull(request);
    expect(body.projects.map((p) => p.id)).toContain(ids.projectId);
    expect(body.environments.map((e) => e.id)).toContain(ids.environmentId);
    expect(body.vars.map((v) => v.id)).toContain(ids.varId);
  });

  test('the key and the value are both unreadable', async ({ request }) => {
    // The key as much as the value: `STRIPE_SECRET_KEY` in the clear tells an
    // operator what a project integrates with.
    const account = await signedIn(request, 'env-opaque');
    await seed(request, account, 'opaque');

    const raw = await (await request.get('/api/env/sync?since=0')).text();
    expect(raw).not.toContain('STRIPE_SECRET_KEY');
    expect(raw).not.toContain('sk_live_opaque');
    expect(raw).not.toContain('production');
  });

  test('never returns another account’s projects', async ({ request, playwright }) => {
    const mine = await signedIn(request, 'env-mine');
    const ids = await seed(request, mine, 'mine');

    const other = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    await signedIn(other, 'env-theirs');

    const body = (await (await other.get('/api/env/sync?since=0')).json()) as SyncBody;
    expect(body.projects.map((p) => p.id)).not.toContain(ids.projectId);
    expect(body.environments.map((e) => e.id)).not.toContain(ids.environmentId);
    expect(body.vars.map((v) => v.id)).not.toContain(ids.varId);

    await other.dispose();
  });

  test('refuses to hang an environment off somebody else’s project', async ({
    request,
    playwright,
  }) => {
    // The attack this endpoint exists to refuse: attach an environment to a
    // project you do not own, then read every variable you put under it — and,
    // worse, have the owner's client sync them down.
    const victim = await signedIn(request, 'env-victim');
    const ids = await seed(request, victim, 'victim');

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'env-attacker');

    const smuggled = crypto.randomUUID();
    const response = await push(attackerContext, [
      {
        op: 'environment-upsert',
        id: smuggled,
        projectId: ids.projectId,
        nameEnc: await encryptString(attacker.keys.dataKey, 'smuggled'),
        sortOrder: 0,
      },
    ]);

    // Answers 200 and changes nothing: an error would confirm the project id.
    expect(response.status()).toBe(200);
    await attackerContext.dispose();

    const body = await pull(request);
    expect(body.environments.map((e) => e.id)).not.toContain(smuggled);
  });

  test('refuses to put a variable in somebody else’s environment', async ({
    request,
    playwright,
  }) => {
    const victim = await signedIn(request, 'env-victim-var');
    const ids = await seed(request, victim, 'victim-var');

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'env-attacker-var');

    const smuggled = crypto.randomUUID();
    await push(attackerContext, [
      {
        op: 'var-upsert',
        id: smuggled,
        environmentId: ids.environmentId,
        keyEnc: await encryptString(attacker.keys.dataKey, 'SMUGGLED'),
        valueEnc: await encryptString(attacker.keys.dataKey, 'x'),
        noteEnc: null,
        sortOrder: 0,
      },
    ]);
    await attackerContext.dispose();

    const body = await pull(request);
    expect(body.vars.map((v) => v.id)).not.toContain(smuggled);
  });

  test('ignores an edit aimed at somebody else’s variable', async ({ request, playwright }) => {
    const victim = await signedIn(request, 'env-edit-victim');
    const ids = await seed(request, victim, 'edit-victim');

    const before = (await pull(request)).vars.find((v) => v.id === ids.varId)?.valueEnc;

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'env-edit-attacker');

    await push(attackerContext, [
      {
        op: 'var-upsert',
        id: ids.varId,
        environmentId: ids.environmentId,
        keyEnc: await encryptString(attacker.keys.dataKey, 'HIJACKED'),
        valueEnc: await encryptString(attacker.keys.dataKey, 'hijacked'),
        noteEnc: null,
        sortOrder: 0,
      },
    ]);
    await attackerContext.dispose();

    const after = (await pull(request)).vars.find((v) => v.id === ids.varId)?.valueEnc;
    expect(after).toBe(before);
  });

  test('a variable delete is soft', async ({ request }) => {
    const account = await signedIn(request, 'env-soft-delete');
    const ids = await seed(request, account, 'soft');

    await push(request, [{ op: 'var-delete', id: ids.varId }]);

    const body = await pull(request);
    const row = body.vars.find((v) => v.id === ids.varId);
    expect(row, 'the variable vanished instead of being marked deleted').toBeDefined();
  });

  test('deleting an environment takes its variables with it', async ({ request }) => {
    // Hard, unlike everything else here, and the cascade is the point: an
    // environment with no `deleted_at` cannot hold orphaned variables.
    const account = await signedIn(request, 'env-cascade');
    const ids = await seed(request, account, 'cascade');

    await push(request, [{ op: 'environment-delete', id: ids.environmentId }]);

    const body = await pull(request);
    expect(body.environments.map((e) => e.id)).not.toContain(ids.environmentId);
    expect(body.vars.map((v) => v.id)).not.toContain(ids.varId);
  });

  test('shares one cursor across all three', async ({ request }) => {
    const account = await signedIn(request, 'env-cursor');
    const ids = await seed(request, account, 'cursor');

    const { cursor } = await pull(request);

    const laterVar = crypto.randomUUID();
    await push(request, [
      {
        op: 'var-upsert',
        id: laterVar,
        environmentId: ids.environmentId,
        keyEnc: await encryptString(account.keys.dataKey, 'LATER'),
        valueEnc: await encryptString(account.keys.dataKey, 'later'),
        noteEnc: null,
        sortOrder: 1,
      },
    ]);

    const delta = await pull(request, cursor);
    expect(delta.vars.map((v) => v.id)).toEqual([laterVar]);
    expect(delta.projects).toEqual([]);
  });

  test('rejects a value that is not ciphertext', async ({ request }) => {
    const account = await signedIn(request, 'env-plaintext');

    const response = await push(request, [
      {
        op: 'project-upsert',
        id: crypto.randomUUID(),
        nameEnc: 'My Project',
        color: null,
      },
    ]);

    expect(response.status()).toBe(400);
    expect(account).toBeDefined();
  });

  test('needs a session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });

    expect((await anonymous.get('/api/env/sync?since=0')).status()).toBe(401);
    expect((await anonymous.post('/api/env/sync', { data: { operations: [] } })).status()).toBe(
      401,
    );

    await anonymous.dispose();
  });
});
