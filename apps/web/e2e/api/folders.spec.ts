import { encryptJson, encryptString } from '@core/crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loginWith, register } from '../helpers/account';
import type { BuiltAccount } from '../helpers/account';

/**
 * Folders, at the sync layer.
 *
 * The server stores folder names as ciphertext and knows nothing about the
 * shape of the tree — it cannot read a name, cannot tell a cycle from a valid
 * hierarchy, and cannot decide which folder is a sensible parent. So the tests
 * here are about the properties it *can* enforce: ownership, soft deletion, and
 * not losing the items inside a deleted folder.
 */

async function signedIn(request: APIRequestContext, label: string): Promise<BuiltAccount> {
  const account = await register(request, label);
  const response = await loginWith(request, account.payload.email, account.payload.authKey);
  expect(response.status()).toBe(200);
  return account;
}

async function createFolder(
  request: APIRequestContext,
  account: BuiltAccount,
  id: string,
  name: string,
  parentId: string | null = null,
) {
  const nameEnc = await encryptString(account.keys.dataKey, name);

  return request.post('/api/vault/sync', {
    data: {
      operations: [{ op: 'folder-upsert', id, nameEnc, parentId, color: '#00FF41', sortOrder: 0 }],
    },
  });
}

async function createItem(
  request: APIRequestContext,
  account: BuiltAccount,
  id: string,
  title: string,
  folderId: string | null,
) {
  const dataEnc = await encryptJson(account.keys.dataKey, {
    type: 'login',
    fields: { title },
  });

  return request.post('/api/vault/sync', {
    data: {
      operations: [{ op: 'upsert', id, type: 'login', dataEnc, folderId, favorite: false }],
    },
  });
}

interface SyncBody {
  items: { id: string; folderId: string | null; deletedAt: number | null }[];
  folders: { id: string; parentId: string | null; nameEnc: string; deletedAt: number | null }[];
  cursor: number;
}

async function pull(request: APIRequestContext, since = 0): Promise<SyncBody> {
  const response = await request.get(`/api/vault/sync?since=${since}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as SyncBody;
}

test.describe('folders', () => {
  test('stores a folder and returns it alongside items', async ({ request }) => {
    // One round trip and one cursor for both. Separate endpoints would let a
    // client hold items pointing at folders it has not pulled, which renders as
    // everything sitting in "no folder".
    const account = await signedIn(request, 'folder');
    const id = crypto.randomUUID();

    expect((await createFolder(request, account, id, 'Work')).status()).toBe(200);

    const body = await pull(request);
    expect(body.folders.map((folder) => folder.id)).toContain(id);
  });

  test('the folder name is unreadable', async ({ request }) => {
    const account = await signedIn(request, 'folder-opaque');
    await createFolder(request, account, crypto.randomUUID(), 'Offshore Accounts');

    const raw = await (await request.get('/api/vault/sync?since=0')).text();
    expect(raw).not.toContain('Offshore Accounts');
  });

  test('nests a folder under another', async ({ request }) => {
    const account = await signedIn(request, 'folder-nested');
    const parent = crypto.randomUUID();
    const child = crypto.randomUUID();

    await createFolder(request, account, parent, 'Work');
    await createFolder(request, account, child, 'Clients', parent);

    const body = await pull(request);
    expect(body.folders.find((folder) => folder.id === child)?.parentId).toBe(parent);
  });

  test('refuses to let a folder parent itself', async ({ request }) => {
    // The one cycle the server can recognise without reading anything. Longer
    // cycles it cannot see, which is why the client breaks those when ordering.
    const account = await signedIn(request, 'folder-self');
    const id = crypto.randomUUID();

    const nameEnc = await encryptString(account.keys.dataKey, 'Loop');
    await request.post('/api/vault/sync', {
      data: {
        operations: [{ op: 'folder-upsert', id, nameEnc, parentId: id, color: null, sortOrder: 0 }],
      },
    });

    const body = await pull(request);
    expect(body.folders.find((folder) => folder.id === id)?.parentId).toBeNull();
  });

  test('deleting a folder keeps the items that were in it', async ({ request }) => {
    // Losing a folder must never mean losing what was inside it. On a product
    // with no password reset that would be a second way to lose data for good.
    const account = await signedIn(request, 'folder-delete');
    const folderId = crypto.randomUUID();
    const itemId = crypto.randomUUID();

    await createFolder(request, account, folderId, 'Temporary');
    await createItem(request, account, itemId, 'Important', folderId);

    await request.post('/api/vault/sync', {
      data: { operations: [{ op: 'folder-delete', id: folderId }] },
    });

    const body = await pull(request);
    const item = body.items.find((candidate) => candidate.id === itemId);

    expect(item, 'the item disappeared with its folder').toBeDefined();
    expect(item?.deletedAt).toBeNull();
    expect(item?.folderId, 'the item still points at a deleted folder').toBeNull();
  });

  test('a folder delete is soft', async ({ request }) => {
    const account = await signedIn(request, 'folder-soft');
    const id = crypto.randomUUID();

    await createFolder(request, account, id, 'Removable');
    await request.post('/api/vault/sync', {
      data: { operations: [{ op: 'folder-delete', id }] },
    });

    const body = await pull(request);
    expect(body.folders.find((folder) => folder.id === id)?.deletedAt).not.toBeNull();
  });

  test('never returns another account’s folders', async ({ request, playwright }) => {
    const mine = await signedIn(request, 'folder-mine');
    const id = crypto.randomUUID();
    await createFolder(request, mine, id, 'Private');

    const other = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    await signedIn(other, 'folder-theirs');

    const body = (await (await other.get('/api/vault/sync?since=0')).json()) as SyncBody;
    expect(body.folders.map((folder) => folder.id)).not.toContain(id);

    await other.dispose();
  });

  test('ignores a folder operation naming somebody else’s folder', async ({
    request,
    playwright,
  }) => {
    const mine = await signedIn(request, 'folder-victim');
    const id = crypto.randomUUID();
    await createFolder(request, mine, id, 'Original');

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'folder-attacker');

    // Answers 200 and changes nothing: an error would confirm the folder exists.
    const response = await createFolder(attackerContext, attacker, id, 'Hijacked');
    expect(response.status()).toBe(200);
    await attackerContext.dispose();

    const body = await pull(request);
    expect(body.folders.filter((folder) => folder.id === id)).toHaveLength(1);
  });

  test('shares one cursor with items', async ({ request }) => {
    const account = await signedIn(request, 'folder-cursor');

    await createFolder(request, account, crypto.randomUUID(), 'First');
    const { cursor } = await pull(request);

    const laterFolder = crypto.randomUUID();
    await createFolder(request, account, laterFolder, 'Second');

    const delta = await pull(request, cursor);
    expect(delta.folders.map((folder) => folder.id)).toEqual([laterFolder]);
    expect(delta.items).toEqual([]);
  });

  test('rejects a folder name that is not ciphertext', async ({ request }) => {
    await signedIn(request, 'folder-plaintext');

    const response = await request.post('/api/vault/sync', {
      data: {
        operations: [
          {
            op: 'folder-upsert',
            id: crypto.randomUUID(),
            nameEnc: 'Work',
            parentId: null,
            color: null,
            sortOrder: 0,
          },
        ],
      },
    });

    expect(response.status()).toBe(400);
  });
});

test.describe('item history', () => {
  test('never returns another account’s versions', async ({ request, playwright }) => {
    // The same rule as everywhere else on this API: an id in a query proves
    // nothing about who it belongs to.
    const mine = await signedIn(request, 'history-mine');
    const itemId = crypto.randomUUID();

    await createItem(request, mine, itemId, 'Original', null);

    const dataEnc = await encryptJson(mine.keys.dataKey, {
      type: 'login',
      fields: { title: 'Original' },
    });

    await request.post('/api/vault/sync', {
      data: { operations: [{ op: 'version', id: crypto.randomUUID(), itemId, dataEnc }] },
    });

    const owner = (await (await request.get(`/api/vault/history?itemId=${itemId}`)).json()) as {
      versions: unknown[];
    };
    expect(owner.versions).toHaveLength(1);

    const other = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    await signedIn(other, 'history-theirs');

    const stranger = (await (await other.get(`/api/vault/history?itemId=${itemId}`)).json()) as {
      versions: unknown[];
    };
    // Empty rather than rejected: a 404 would confirm the id is real.
    expect(stranger.versions).toEqual([]);

    await other.dispose();
  });

  test('ignores a version aimed at somebody else’s item', async ({ request, playwright }) => {
    const mine = await signedIn(request, 'history-victim');
    const itemId = crypto.randomUUID();
    await createItem(request, mine, itemId, 'Original', null);

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'history-attacker');

    await attackerContext.post('/api/vault/sync', {
      data: {
        operations: [
          {
            op: 'version',
            id: crypto.randomUUID(),
            itemId,
            dataEnc: await encryptJson(attacker.keys.dataKey, {
              type: 'login',
              fields: { title: 'Smuggled' },
            }),
          },
        ],
      },
    });
    await attackerContext.dispose();

    const body = (await (await request.get(`/api/vault/history?itemId=${itemId}`)).json()) as {
      versions: unknown[];
    };
    expect(body.versions).toEqual([]);
  });

  test('needs a session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    const response = await anonymous.get(`/api/vault/history?itemId=${crypto.randomUUID()}`);

    expect(response.status()).toBe(401);
    await anonymous.dispose();
  });
});
