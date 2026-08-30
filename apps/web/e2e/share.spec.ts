import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * One-time share links.
 *
 * Three properties, and the first is the only reason the rest are worth
 * anything: the key lives after the `#`, so it never reaches the server. The
 * link opens once. And a preview bot fetching it does not count as that once.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';
const SECRET = 'the-shared-password-8812';

async function openVault(page: Page, label: string): Promise<void> {
  await openAccount(page, label, PASSWORD);
}

/** An item with a password, and a share link for it. */
async function makeLink(page: Page, label: string): Promise<string> {
  await openVault(page, label);

  await page.getByTestId('new-item').click();
  await page.getByTestId('item-title').fill('Shared');
  await page.getByTestId('item-password').fill(SECRET);
  await page.getByTestId('item-save').click();
  await expect(page.getByTestId('item-list')).toContainText('Shared');

  await page.getByTestId('share-item').click();
  await page.getByTestId('share-create').click();
  await expect(page.getByTestId('share-link')).toBeVisible({ timeout: 30_000 });

  return (await page.getByTestId('share-link').textContent()) ?? '';
}

test.describe('share links', () => {
  test.slow();

  test('opens once, for somebody with no account', async ({ page, browser }) => {
    const link = await makeLink(page, 'share-basic');
    expect(link).toContain('#');

    // A separate context: no session, no keys, nothing of the sender's.
    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();

    await theirs.goto(link);
    await theirs.getByTestId('share-reveal').click();
    await expect(theirs.getByTestId('share-secret')).toHaveText(SECRET, { timeout: 30_000 });

    await stranger.close();
  });

  test('the key never reaches the server', async ({ page, browser }) => {
    // The property the whole design rests on. A refactor that moved the key
    // into the path would break nothing visible and hand the server every key
    // ever generated.
    const link = await makeLink(page, 'share-fragment');
    const key = link.split('#')[1] ?? '';
    expect(key.length).toBeGreaterThan(20);

    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();

    const sent: string[] = [];
    theirs.on('request', (request) => sent.push(request.url()));

    await theirs.goto(link);
    await theirs.getByTestId('share-reveal').click();
    await expect(theirs.getByTestId('share-secret')).toHaveText(SECRET, { timeout: 30_000 });

    expect(sent.length, 'no requests were seen, so this proves nothing').toBeGreaterThan(0);
    for (const url of sent) expect(url).not.toContain(key);

    await stranger.close();
  });

  test('a second open finds nothing', async ({ page, browser }) => {
    const link = await makeLink(page, 'share-once');

    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();

    await theirs.goto(link);
    await theirs.getByTestId('share-reveal').click();
    await expect(theirs.getByTestId('share-secret')).toBeVisible({ timeout: 30_000 });

    // The recipient going back to it. A plain `goto` of the same URL is a
    // fragment navigation and does not reload, which is how this test first
    // passed while proving nothing.
    await theirs.reload();
    await expect(theirs.getByTestId('share-gone')).toBeVisible({ timeout: 30_000 });

    // And the case that actually matters: the link has leaked, and somebody
    // else has it.
    const second = await browser.newContext();
    const elsewhere = await second.newPage();
    await elsewhere.goto(link);
    await expect(elsewhere.getByTestId('share-gone')).toBeVisible({ timeout: 30_000 });

    await second.close();
    await stranger.close();
  });

  test('two requests at once do not both get it', async ({ page, request }) => {
    // "One-time" that becomes twice under load is not a property, it is a hope.
    // Reading the row and then writing the count is a race two requests a
    // millisecond apart win; the count is checked and incremented in the same
    // statement, and this is the test that can tell the difference.
    const link = await makeLink(page, 'share-race');
    // The API, not the page: `/s/<token>` renders HTML and the bot test below
    // is the one that cares about that path.
    const token = new URL(link).pathname.replace('/s/', '');
    const api = `/api/share/${token}`;

    const [first, second] = await Promise.all([request.post(api), request.post(api)]);

    const bodies = await Promise.all([
      first.json() as Promise<{ status: string }>,
      second.json() as Promise<{ status: string }>,
    ]);

    const opened = bodies.filter((body) => body.status === 'ready');
    expect(opened, 'both requests opened the same one-time share').toHaveLength(1);
  });

  test('a preview bot fetching the link does not spend it', async ({ page, browser, request }) => {
    // Slack, WhatsApp and iMessage all fetch a link before a person sees it. If
    // that counted as the one view, the recipient would find an empty page and
    // the sender would have no idea why.
    const link = await makeLink(page, 'share-unfurl');
    const path = new URL(link).pathname;

    const crawl = await request.get(path);
    expect(crawl.status()).toBe(200);

    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();

    await theirs.goto(link);
    await theirs.getByTestId('share-reveal').click();
    await expect(theirs.getByTestId('share-secret')).toHaveText(SECRET, { timeout: 30_000 });

    await stranger.close();
  });

  test('says so when the key was cut off the link', async ({ page, browser }) => {
    // Some chat clients drop the fragment. The share is spent either way, and
    // saying otherwise sends somebody back to a link that is gone.
    const link = await makeLink(page, 'share-no-key');

    const stranger = await browser.newContext();
    const theirs = await stranger.newPage();

    await theirs.goto(link.split('#')[0] ?? '');
    await theirs.getByTestId('share-reveal').click();
    await expect(theirs.getByTestId('share-unreadable')).toBeVisible({ timeout: 30_000 });

    await stranger.close();
  });

  test('the server stores no readable copy of what was shared', async ({ page }) => {
    // Watched at the wire, like the vault's own zero-knowledge tests: whatever
    // the create request carries, the password is not in it.
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await makeLink(page, 'share-opaque');

    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) expect(body).not.toContain(SECRET);
  });

  test('needs a session to make one', async ({ request }) => {
    const response = await request.post('/api/vault/share', { data: { payload: 'anything' } });
    expect(response.status()).toBe(401);
  });

  test('answers the same for a link that was never real', async ({ page }) => {
    // Distinguishing "expired" from "never existed" would make this an oracle
    // for whether a guessed token was ever a token.
    await page.goto('/s/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    await expect(page.getByTestId('share-gone')).toBeVisible({ timeout: 30_000 });
  });
});
