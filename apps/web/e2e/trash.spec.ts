import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';
import { openPanel } from './helpers/vault-nav';

/**
 * The trash, and the one way out of it that does not come back.
 *
 * Two properties. A permanent delete has to actually be permanent — the row,
 * its versions, and the bytes any attachment left in R2 — because a delete that
 * leaves ciphertext on the server is the opposite of what somebody pressing it
 * is asking for.
 *
 * And the screen's own sentence has to be true. It has said "deleted items stay
 * here for 30 days" since the trash existed, `TRASH_RETENTION_DAYS` has been 30
 * the whole time, and nothing read it: items sat there for as long as the
 * account did.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

async function openVault(page: Page, label: string): Promise<string> {
  return openAccount(page, label, PASSWORD);
}

async function makeItem(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill(title);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText(title);
}

async function trashItem(page: Page, title: string): Promise<void> {
  // By row rather than `.first()`, and asserted on the row count rather than on
  // the list's text: deleting the last item replaces the list with the empty
  // state, so `item-list` stops existing and a text assertion against it fails
  // for a reason that has nothing to do with deleting.
  const row = page.getByTestId('item-row').filter({ hasText: title });
  await row.getByTestId('delete-item').click();
  await expect(row).toHaveCount(0);
}

async function openTrash(page: Page): Promise<void> {
  await openPanel(page, 'open-trash');
  await expect(page.getByTestId('trash-list')).toBeVisible();
}

/** Every item this account has, deleted or not, straight from the server. */
async function serverItems(page: Page): Promise<{ id: string; deletedAt: number | null }[]> {
  return page.evaluate(async () => {
    const response = await fetch('/api/vault/sync?since=0');
    const body = (await response.json()) as { items: { id: string; deletedAt: number | null }[] };
    return body.items;
  });
}

test.describe('permanent delete', () => {
  test.slow();

  test('asks before it does it, and the first answer can be no', async ({ page }) => {
    // The one action here with no way back, in a product with no password
    // reset. A single click would be wrong.
    await openVault(page, 'trash-confirm');
    await makeItem(page, 'Doomed');
    await trashItem(page, 'Doomed');
    await openTrash(page);

    await page.getByTestId('purge-item').click();
    await expect(page.getByTestId('purge-confirm')).toContainText('Doomed');

    await page.getByRole('button', { name: 'keep it' }).click();
    await expect(page.getByTestId('trash-row')).toHaveCount(1);

    // Still on the server, which is the point of saying no.
    expect(await serverItems(page)).toHaveLength(1);
  });

  test('removes the row from the server, not just from the screen', async ({ page }) => {
    // A delete that only hid the item locally would leave its ciphertext on the
    // server forever, which is the opposite of what the button says.
    await openVault(page, 'trash-purge');
    await makeItem(page, 'Doomed');
    await trashItem(page, 'Doomed');
    await openTrash(page);

    expect(await serverItems(page)).toHaveLength(1);

    /*
     * Whether the delete has reached the server yet is deliberately not
     * asserted, because both orderings have to work and asserting one hides the
     * other.
     *
     * If it has landed, the server sees a trashed row and purges it. If it is
     * still in the outbox, the purge travels in the same batch behind it — they
     * are queued under separate keys for exactly that reason — and the server
     * treats an item deleted earlier in the batch as trashed.
     *
     * Pinning it down was how the second path was found to be broken at all:
     * asserting the delete had landed turned an intermittent failure into a
     * reproducible one.
     */
    await page.getByTestId('purge-item').click();
    await page.getByTestId('purge-confirm-yes').click();

    await expect(page.getByTestId('trash-row')).toHaveCount(0);
    await expect.poll(async () => (await serverItems(page)).length, { timeout: 30_000 }).toBe(0);
  });

  test('takes the attachment bytes with it', async ({ page }) => {
    // An orphaned R2 object is unreachable, uncounted against the quota, and
    // permanent — the worst of both, since the file is gone from the vault and
    // still sitting in the bucket.
    await openVault(page, 'trash-purge-files');
    await makeItem(page, 'WithFile');

    await page.getByTestId('item-files').click();
    await expect(page.getByTestId('attachments-loading')).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId('attachment-file').setInputFiles({
      name: 'secret.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('x'.repeat(4096)),
    });
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const marker = await page.getByTestId('attachment-quota').textContent();
    expect(marker).not.toContain('0 KB of');

    await trashItem(page, 'WithFile');
    await openTrash(page);
    await page.getByTestId('purge-item').click();
    await page.getByTestId('purge-confirm-yes').click();
    await expect(page.getByTestId('trash-row')).toHaveCount(0);

    // The quota is the only thing that can see into the bucket from here, and
    // it is derived from the attachment rows — which the purge had to take.
    await page.getByTestId('trash-back').click();
    await makeItem(page, 'Fresh');
    await page.getByTestId('item-files').click();
    await expect(page.getByTestId('attachments-loading')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('attachment-quota')).toContainText('0 KB of');
  });

  test('stays gone after a reload, not just on screen', async ({ page }) => {
    /*
     * The test the first version of this feature did not have, and the bug it
     * would have caught.
     *
     * A purge is not an upsert and not a delete, so the code that turns an
     * operation into a cached row treated it as a restore: it wrote the item
     * back into IndexedDB with `deletedAt: null`. Permanently deleting a note
     * removed it from the screen, removed it from the server, and left a
     * healthy copy on the device that came back on the next load — restored,
     * not even in the trash.
     *
     * Every earlier assertion here looked at the screen or the server within
     * the same page. Neither could see it.
     */
    await openVault(page, 'trash-reload');
    await makeItem(page, 'Doomed');
    await trashItem(page, 'Doomed');
    await openTrash(page);

    await page.getByTestId('purge-item').click();
    await page.getByTestId('purge-confirm-yes').click();
    await expect(page.getByTestId('trash-row')).toHaveCount(0);

    // Straight from IndexedDB, which is what a reload reads. A row here is the
    // item coming back whatever the server says.
    const cached = await page.evaluate(async () => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('core-vault');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

      return new Promise<number>((resolve) => {
        const count = database.transaction('cache').objectStore('cache').count();
        count.onsuccess = () => resolve(count.result);
        count.onerror = () => resolve(-1);
      });
    });

    expect(cached, 'the purged item is still cached on the device').toBe(0);
  });

  test('empties the whole trash at once', async ({ page }) => {
    await openVault(page, 'trash-empty');
    await makeItem(page, 'One');
    await makeItem(page, 'Two');
    await trashItem(page, 'One');
    await trashItem(page, 'Two');
    await openTrash(page);

    await expect(page.getByTestId('trash-row')).toHaveCount(2);

    await page.getByTestId('empty-trash').click();
    await expect(page.getByTestId('empty-trash-confirm')).toContainText('2 item(s)');
    await page.getByTestId('empty-trash-yes').click();

    await expect(page.getByTestId('trash-row')).toHaveCount(0);
    await expect.poll(async () => (await serverItems(page)).length, { timeout: 30_000 }).toBe(0);
  });

  test('will not purge an item that is not in the trash', async ({ page }) => {
    // The guard that stops a replayed or malformed request taking a live item
    // straight out of the vault.
    await openVault(page, 'trash-live');
    await makeItem(page, 'Alive');

    const before = await serverItems(page);
    expect(before).toHaveLength(1);

    const status = await page.evaluate(async (id) => {
      const response = await fetch('/api/vault/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operations: [{ op: 'purge', id }] }),
      });
      return response.status;
    }, before[0]?.id ?? '');

    expect(status).toBe(200);

    // Answered normally and did nothing, which is how every other unauthorised
    // operation in sync behaves: a rejection would confirm the id is real.
    expect(await serverItems(page)).toHaveLength(1);
  });

  test('does not let one account purge another’s item', async ({ page, browser }) => {
    await openVault(page, 'trash-mine');
    await makeItem(page, 'Mine');
    await trashItem(page, 'Mine');

    const mine = await serverItems(page);
    expect(mine).toHaveLength(1);

    const other = await browser.newContext();
    const theirPage = await other.newPage();
    await openVault(theirPage, 'trash-stranger');

    await theirPage.evaluate(async (id) => {
      await fetch('/api/vault/sync', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ operations: [{ op: 'purge', id }] }),
      });
    }, mine[0]?.id ?? '');

    expect(await serverItems(page)).toHaveLength(1);
    await other.close();
  });
});
