import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { buildAccount, uniqueEmail } from './account';

/**
 * An unlocked vault, without walking through signup.
 *
 * Almost every browser test needs an account and does not care how it was
 * created. Doing it through the signup page costs three form fields, the
 * Emergency Kit screen, a redirect and a second form — perhaps eight seconds,
 * times four hundred tests, on every run.
 *
 * So the account is created through the API and only the unlock happens in the
 * browser. The unlock is the part that matters here: it is what puts keys in
 * memory, and it is the path every test after it depends on.
 *
 * The signup *page* is still tested, in `signup-ui.spec.ts` and
 * `kdf-params.spec.ts`, which use the real flow because it is what they are
 * about. This helper is for the tests where signup is scenery.
 */

export const VAULT_PASSWORD = 'correct-horse-battery-staple-7391';

/** Sign in as a new account and land on an unlocked vault. */
export async function openVault(
  page: Page,
  label: string,
  password: string = VAULT_PASSWORD,
): Promise<string> {
  const account = await buildAccount(uniqueEmail(label), password);

  // `page.request` shares the browser context's cookies, so what happens here
  // and what happens in the page are the same session.
  const created = await page.request.post('/api/auth/signup', { data: account.payload });
  expect(created.status(), 'could not create the test account').toBe(200);

  await unlockVault(page, account.payload.email, password);
  return account.payload.email;
}

/** Unlock an existing account through the login page. */
export async function unlockVault(
  page: Page,
  email: string,
  password: string = VAULT_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('email').fill(email);
  await page.getByLabel('master password').fill(password);
  await page.getByTestId('unlock').click();
  await expect(page).toHaveURL(/\/vault$/, { timeout: 45_000 });
}
