import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * Attachments.
 *
 * Two things are under test. That a file survives the round trip at all, and —
 * the one worth a suite — that everything leaving the browser is opaque: the
 * bytes, the filename, and the type. A server that could sort this list by name
 * would be reading it.
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

async function openFiles(page: Page): Promise<void> {
  await page.getByTestId('item-files').click();
  await expect(page.getByTestId('attachments')).toBeVisible();
  await expect(page.getByTestId('attachments-loading')).toHaveCount(0, { timeout: 30_000 });
}

async function attach(page: Page, name: string, body: string): Promise<void> {
  await page.getByTestId('attachment-file').setInputFiles({
    name,
    mimeType: 'application/pdf',
    buffer: Buffer.from(body),
  });
}

test.describe('attachments', () => {
  test.slow();

  test('attaches a file and lists it by name', async ({ page }) => {
    await openVault(page, 'attach-basic');
    await makeItem(page, 'Passport');
    await openFiles(page);

    await expect(page.getByTestId('attachments-empty')).toBeVisible();

    await attach(page, 'passport-scan.pdf', 'the scanned contents');

    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('attachment-list')).toContainText('passport-scan.pdf');
  });

  test('gives the file back exactly as it went in', async ({ page }) => {
    await openVault(page, 'attach-roundtrip');
    await makeItem(page, 'Keys');
    await openFiles(page);

    await attach(page, 'recovery.txt', 'line one\nline two');
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('attachment-download').click(),
    ]);

    expect(download.suggestedFilename()).toBe('recovery.txt');

    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);

    expect(Buffer.concat(chunks).toString('utf8')).toBe('line one\nline two');
  });

  test('sends neither the contents nor the filename', async ({ page }) => {
    // The claim the whole feature rests on. Watched at the wire, like the
    // vault's own zero-knowledge tests.
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'attach-opaque');
    await makeItem(page, 'Papers');
    await openFiles(page);
    await attach(page, 'divorce-settlement.pdf', 'the-secret-contents-9931');
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    expect(bodies.length, 'no request bodies were seen, so this proves nothing').toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body).not.toContain('the-secret-contents-9931');
      expect(body).not.toContain('divorce-settlement');
    }
  });

  test('the listing carries no readable name either', async ({ page }) => {
    // The upload is one direction. What comes back has to be opaque too, or the
    // server is reading the list it serves.
    await openVault(page, 'attach-listing');
    await makeItem(page, 'Papers');
    await openFiles(page);
    await attach(page, 'divorce-settlement.pdf', 'x');
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const itemId = await page.evaluate(async () => {
      const response = await fetch('/api/vault/sync?since=0');
      const body = (await response.json()) as { items: { id: string }[] };
      return body.items[0]?.id ?? '';
    });

    const raw = await page.evaluate(async (id) => {
      const response = await fetch(`/api/vault/attachments?itemId=${id}`);
      return response.text();
    }, itemId);

    expect(raw).toContain('itemKeyWrapped');
    expect(raw).not.toContain('divorce-settlement');
  });

  test('removes one, and the quota goes back down', async ({ page }) => {
    await openVault(page, 'attach-remove');
    await makeItem(page, 'Papers');
    await openFiles(page);

    await attach(page, 'a.pdf', 'x'.repeat(4096));
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const before = (await page.getByTestId('attachment-quota').textContent()) ?? '';

    await page.getByTestId('attachment-delete').click();
    await expect(page.getByTestId('attachment-row')).toHaveCount(0, { timeout: 30_000 });

    const after = (await page.getByTestId('attachment-quota').textContent()) ?? '';
    expect(after).not.toBe(before);
    expect(after).toContain('0 KB of');
  });

  test('will not serve one account another account’s file', async ({ page, browser }) => {
    // The row has no user id — ownership is a join through the item. A lookup
    // by id alone would serve any file to anybody who guessed a UUID.
    await openVault(page, 'attach-mine');
    await makeItem(page, 'Papers');
    await openFiles(page);
    await attach(page, 'mine.pdf', 'private');
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const id = await page.evaluate(async () => {
      const sync = await fetch('/api/vault/sync?since=0');
      const items = ((await sync.json()) as { items: { id: string }[] }).items;
      const list = await fetch(`/api/vault/attachments?itemId=${items[0]?.id ?? ''}`);
      return ((await list.json()) as { attachments: { id: string }[] }).attachments[0]?.id ?? '';
    });

    expect(id).not.toBe('');

    // A second account with a real session of its own. An unauthenticated
    // request would be refused by the session guard before ownership was ever
    // consulted, and this test would then pass with the ownership join deleted
    // -- which is exactly what it did the first time it was written.
    const other = await browser.newContext();
    const theirPage = await other.newPage();
    await openVault(theirPage, 'attach-stranger');

    const mine = await theirPage.request.get(`/api/vault/attachments/${id}`);
    expect(mine.status()).toBe(401);

    // The stranger's session is real, proved by a call that should work.
    const theirOwn = await theirPage.request.get('/api/vault/sync?since=0');
    expect(theirOwn.status()).toBe(200);

    await other.close();
  });

  test('the operator, holding the disk, has nothing readable', async ({ page }) => {
    /*
     * The strongest version of the claim, and the one somebody actually asks
     * about: not "the network is clean" but "the person who runs the server
     * cannot read this".
     *
     * So this reads what that person has. Locally the bindings are miniflare,
     * which keeps R2 objects as files and D1 as a SQLite database under
     * `.wrangler/state` — the same two things a Cloudflare account holds. Every
     * byte of both is searched for the filename and the contents.
     *
     * A unique marker per run, because the local state is shared across the
     * suite and a leftover row from something else would make this pass or fail
     * for reasons that have nothing to do with what it is testing.
     */
    const marker = `zk${Date.now().toString(36)}${Math.trunc(performance.now())}`;

    await openVault(page, 'attach-operator');
    await makeItem(page, 'Papers');
    await openFiles(page);
    await attach(page, `${marker}-name.pdf`, `${marker}-contents`);
    await expect(page.getByTestId('attachment-row')).toHaveCount(1, { timeout: 30_000 });

    const state = join(process.cwd(), '.wrangler', 'state', 'v3');

    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(full);
      }
    };
    walk(state);

    expect(files.length, 'no local state was found, so this proves nothing').toBeGreaterThan(0);

    // Proof the search would find the marker if it were there: it is in the
    // page right now, and the same search over the DOM finds it.
    expect(await page.getByTestId('attachment-list').textContent()).toContain(marker);

    let read = 0;
    for (const file of files) {
      let bytes: Buffer;
      try {
        bytes = readFileSync(file);
      } catch {
        // Another test in the same run removed an attachment between the walk
        // and this read. Skipped rather than failed — a blob that no longer
        // exists is not a blob with a secret in it — but counted, so that a
        // state directory that vanished entirely cannot look like a pass.
        continue;
      }

      read += 1;
      expect(bytes.includes(`${marker}-contents`), `contents found in ${file}`).toBe(false);
      expect(bytes.includes(`${marker}-name`), `filename found in ${file}`).toBe(false);
    }

    expect(read, 'nothing on disk could be read, so this proves nothing').toBeGreaterThan(0);
  });

  test('needs a session at all', async ({ request }) => {
    const response = await request.get('/api/vault/attachments?itemId=anything');
    expect(response.status()).toBe(401);
  });
});
