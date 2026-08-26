import { encryptJson } from '@core/crypto';
import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import { loginWith, register } from './helpers/account';
import type { BuiltAccount } from './helpers/account';

/**
 * /api/vault/sync
 *
 * The route that carries the actual vault. It deals only in opaque blobs, so
 * most of what is worth testing is what it refuses to do: read anything, hand
 * one user another user's items, or delete something permanently.
 */

async function signedIn(request: APIRequestContext, label: string): Promise<BuiltAccount> {
  const account = await register(request, label);
  const response = await loginWith(request, account.payload.email, account.payload.authKey);
  expect(response.status()).toBe(200);
  return account;
}

async function upsert(
  request: APIRequestContext,
  account: BuiltAccount,
  id: string,
  title: string,
  password = 'hunter2',
) {
  const dataEnc = await encryptJson(account.keys.dataKey, {
    type: 'login',
    fields: { title, username: 'me@example.com', password },
  });

  return request.post('/api/vault/sync', {
    data: {
      operations: [
        { op: 'upsert', id, type: 'login', dataEnc, folderId: null, favorite: false },
      ],
    },
  });
}

test.describe('vault sync', () => {
  test('stores an item and returns it on the next pull', async ({ request }) => {
    const account = await signedIn(request, 'sync');
    const id = crypto.randomUUID();

    expect((await upsert(request, account, id, 'GitHub')).status()).toBe(200);

    const pull = await request.get('/api/vault/sync?since=0');
    const body = (await pull.json()) as { items: { id: string; dataEnc: string }[] };

    expect(body.items.map((item) => item.id)).toContain(id);
  });

  test('what it stores is unreadable', async ({ request }) => {
    const account = await signedIn(request, 'opaque');
    const id = crypto.randomUUID();
    await upsert(request, account, id, 'My Bank Login', 'correct-horse-battery');

    const pull = await request.get('/api/vault/sync?since=0');
    const raw = await pull.text();

    expect(raw).not.toContain('My Bank Login');
    expect(raw).not.toContain('correct-horse-battery');
    expect(raw).not.toContain('me@example.com');
  });

  test('refuses without a session', async ({ playwright }) => {
    const anonymous = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    expect((await anonymous.get('/api/vault/sync?since=0')).status()).toBe(401);
    expect((await anonymous.post('/api/vault/sync', { data: { operations: [] } })).status()).toBe(
      401,
    );
    await anonymous.dispose();
  });

  test("never returns another account's items", async ({ request, playwright }) => {
    const mine = await signedIn(request, 'mine');
    const id = crypto.randomUUID();
    await upsert(request, mine, id, 'Private');

    const other = await playwright.request.newContext({ baseURL: 'http://localhost:3000' });
    const theirs = await signedIn(other, 'theirs');
    expect(theirs).toBeDefined();

    const pull = await other.get('/api/vault/sync?since=0');
    const body = (await pull.json()) as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).not.toContain(id);
    await other.dispose();
  });

  test('ignores an operation naming an item owned by somebody else', async ({
    request,
    playwright,
  }) => {
    // Silently, not with an error: a rejection would confirm the item exists.
    const mine = await signedIn(request, 'victim');
    const id = crypto.randomUUID();
    await upsert(request, mine, id, 'Original');

    const attackerContext = await playwright.request.newContext({
      baseURL: 'http://localhost:3000',
    });
    const attacker = await signedIn(attackerContext, 'attacker');

    const response = await upsert(attackerContext, attacker, id, 'Overwritten');
    expect(response.status()).toBe(200);
    await attackerContext.dispose();

    // The original owner's item is untouched, and still theirs.
    const pull = await request.get('/api/vault/sync?since=0');
    const body = (await pull.json()) as { items: { id: string }[] };
    expect(body.items.filter((item) => item.id === id)).toHaveLength(1);
  });

  test('deletes are soft, so trash can restore them', async ({ request }) => {
    const account = await signedIn(request, 'trash');
    const id = crypto.randomUUID();
    await upsert(request, account, id, 'Deletable');

    await request.post('/api/vault/sync', { data: { operations: [{ op: 'delete', id }] } });

    const afterDelete = await request.get('/api/vault/sync?since=0');
    const deleted = ((await afterDelete.json()) as { items: { id: string; deletedAt: number | null }[] })
      .items.find((item) => item.id === id);

    expect(deleted?.deletedAt).not.toBeNull();

    await request.post('/api/vault/sync', { data: { operations: [{ op: 'restore', id }] } });

    const afterRestore = await request.get('/api/vault/sync?since=0');
    const restored = ((await afterRestore.json()) as { items: { id: string; deletedAt: number | null }[] })
      .items.find((item) => item.id === id);

    expect(restored?.deletedAt).toBeNull();
  });

  test('a delta pull returns only what changed', async ({ request }) => {
    const account = await signedIn(request, 'delta');

    await upsert(request, account, crypto.randomUUID(), 'First');
    const first = await request.get('/api/vault/sync?since=0');
    const cursor = ((await first.json()) as { cursor: number }).cursor;

    const laterId = crypto.randomUUID();
    await upsert(request, account, laterId, 'Second');

    const second = await request.get(`/api/vault/sync?since=${cursor}`);
    const body = (await second.json()) as { items: { id: string }[] };

    expect(body.items.map((item) => item.id)).toEqual([laterId]);
  });

  test('rejects anything that is not a ciphertext envelope', async ({ request }) => {
    await signedIn(request, 'envelope');

    const response = await request.post('/api/vault/sync', {
      data: {
        operations: [
          {
            op: 'upsert',
            id: crypto.randomUUID(),
            type: 'login',
            dataEnc: 'plaintext password',
            folderId: null,
            favorite: false,
          },
        ],
      },
    });

    expect(response.status()).toBe(400);
  });

  test('never caches', async ({ request }) => {
    await signedIn(request, 'nocache');
    const response = await request.get('/api/vault/sync?since=0');
    expect(response.headers()['cache-control']).toContain('no-store');
  });
});
