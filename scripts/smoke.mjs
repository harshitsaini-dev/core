/**
 * Does the app actually work?
 *
 * Thirty seconds, in a real browser: sign up, unlock, store a password, create
 * an environment project — and report every console error and page error on the
 * way. It is not a substitute for the end-to-end suite and does not try to be.
 *
 * It exists because the suite is not a substitute for this either. A run of six
 * hundred passing tests says the paths they cover behave; it does not say the
 * page loads, and on the day a stale build served a broken chunk the tests were
 * green and the app was blank. The only way to know an app works is to open it.
 *
 * Needs `pnpm dev` already running.
 */
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 120)}`);
});

const email = `smoke-${Date.now()}@core.test`;
const password = 'correct-horse-battery-staple-7391';

await page.goto('http://localhost:3000/signup');
await page.getByLabel('email').fill(email);
await page.getByLabel('master password', { exact: true }).fill(password);
await page.getByLabel('confirm master password').fill(password);
await page.getByRole('button', { name: 'create vault' }).click();

await page.getByTestId('kit-acknowledge').waitFor({ timeout: 60000 });
await page.getByTestId('kit-acknowledge').check();
await page.getByTestId('kit-continue').click();

await page.getByLabel('email').fill(email);
await page.getByLabel('master password').fill(password);
await page.getByTestId('unlock').click();
await page.waitForURL(/\/vault$/, { timeout: 60000 });
console.log('signed up and unlocked');

await page.getByTestId('new-item').click();
await page.getByTestId('item-title').fill('GitHub');
await page.getByTestId('item-password').fill('a-real-password');
await page.getByTestId('item-save').click();
await page.getByTestId('item-row-title').waitFor();
console.log('item stored:', await page.getByTestId('item-row-title').innerText());

await page.getByTestId('open-env').click();
await page.waitForURL(/\/env/);
await page.getByTestId('project-name').fill('Checkout');
await page.getByTestId('project-create').click();
await page.getByTestId('environment-tab').first().waitFor();
console.log(
  'env project created with',
  await page.getByTestId('environment-tab').count(),
  'environments',
);

// Git-ignored. This is a picture of a vault, taken on whatever machine ran
// the check — harmless on a throwaway account, and not a habit worth having
// in a repository that anybody can read.
await page.screenshot({ path: 'vault-screenshot.png', fullPage: true });
console.log(errors.length === 0 ? 'no console or page errors' : errors.join('\n'));
await browser.close();
