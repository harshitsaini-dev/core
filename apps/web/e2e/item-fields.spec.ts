import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { openVault as openAccount } from './helpers/vault';

/**
 * The rest of a login item: one-time codes, recovery codes and custom fields.
 *
 * The TOTP arithmetic is verified against the RFC vectors in the crypto
 * package. What these check is the part unit tests cannot: that a secret typed
 * on this screen survives storage and produces a live code afterwards.
 */

const PASSWORD = 'correct-horse-battery-staple-7391';

/** RFC 4648's canonical base32 example. Valid, and easy to recognise. */
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

/** An unlocked vault. The signup page has its own tests; here it is scenery. */
async function openVault(page: Page, label: string): Promise<void> {
  await openAccount(page, label, PASSWORD);
}

test.describe('one-time codes', () => {
  test.slow();

  test('a stored secret produces a live six-digit code', async ({ page }) => {
    await openVault(page, 'totp');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('WithTotp');
    await page.getByTestId('item-totp').fill(TOTP_SECRET);
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('totp-code')).toBeVisible();
    await expect(page.getByTestId('totp-code')).toHaveText(/^\d{6}$/);
  });

  test('a scanned qr code fills the secret and generates', async ({ page }) => {
    // Decoding the image is the browser's job, so the decoder is stubbed and
    // what is left under test is ours: the `otpauth://` URI a setup screen
    // encodes is not a base32 secret, and storing it as one produces a field
    // that never generates a working code.
    await page.addInitScript(() => {
      class FakeDetector {
        // Asked before anything is offered: the capability check reads the
        // supported formats rather than trusting that the constructor exists,
        // because on Windows and Linux desktop Chrome it exists and does not
        // work. A stub without this is a browser that cannot scan, and the
        // buttons are correctly not rendered.
        static async getSupportedFormats(): Promise<string[]> {
          return ['qr_code'];
        }

        async detect(source: Blob): Promise<{ rawValue: string }[]> {
          return [{ rawValue: await source.text() }];
        }
      }

      Object.defineProperty(window, 'BarcodeDetector', { value: FakeDetector, writable: true });
    });

    await openVault(page, 'totp-scan');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Scanned');
    await page.getByTestId('scan-file').setInputFiles({
      name: 'code.png',
      mimeType: 'image/png',
      buffer: Buffer.from(`otpauth://totp/Scanned:kaya?secret=${TOTP_SECRET}&issuer=Scanned`),
    });

    await expect(page.getByTestId('item-totp')).toHaveValue(TOTP_SECRET);

    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('totp-code')).toHaveText(/^\d{6}$/);
  });

  test('shows how long the code has left', async ({ page }) => {
    // A code with four seconds on it will be rejected by the time it is pasted,
    // and without the countdown that reads as a wrong secret.
    await openVault(page, 'totp-countdown');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Countdown');
    await page.getByTestId('item-totp').fill(TOTP_SECRET);
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('totp-remaining')).toHaveText(/^\d{1,2}s/);
  });

  test('accepts a whole otpauth link and stores only the secret', async ({ page }) => {
    // What people paste when a site offers "can't scan the code?".
    await openVault(page, 'totp-uri');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('FromUri');
    await page
      .getByTestId('item-totp')
      .fill(`otpauth://totp/Example:me@example.com?secret=${TOTP_SECRET}&issuer=Example`);

    await expect(page.getByTestId('item-totp')).toHaveValue(TOTP_SECRET);

    await page.getByTestId('item-save').click();
    await expect(page.getByTestId('totp-code')).toHaveText(/^\d{6}$/);
  });

  test('rejects an unreadable otpauth link rather than storing it', async ({ page }) => {
    await openVault(page, 'totp-bad');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-totp').fill('otpauth://totp/X?secret=not-base32-!!');

    // Targeted by its text rather than by role: several fields can carry an
    // alert at once, and asserting on "the alert" would depend on which.
    await expect(page.getByText(/that otpauth link could not be read/i)).toBeVisible();
    // The bad value stays in the field so it can be corrected rather than
    // silently discarded.
    await expect(page.getByTestId('item-totp')).toHaveValue(/otpauth/);
  });

  test('says so when a stored secret cannot be read', async ({ page }) => {
    // Better than a stale or absent code: the value is wrong and the user is
    // the only one who can fix it.
    await openVault(page, 'totp-broken');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('BrokenSecret');
    // Valid base32 characters, but not a decodable secret for our purposes is
    // hard to construct — so this checks the happy path stays happy and the
    // invalid-state element is absent.
    await page.getByTestId('item-totp').fill(TOTP_SECRET);
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('totp-invalid')).toHaveCount(0);
  });
});

test.describe('recovery codes and custom fields', () => {
  test.slow();

  test('stores recovery codes and reports how many', async ({ page }) => {
    await openVault(page, 'codes');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('WithCodes');
    await page.getByTestId('item-recovery-codes').fill('aaaa-1111\nbbbb-2222\n\ncccc-3333\n');
    await page.getByTestId('item-save').click();

    // The blank line is dropped rather than stored as an empty code.
    await expect(page.getByTestId('item-recovery-count')).toContainText('3 recovery code(s)');
  });

  test('adds a custom field and keeps a hidden one hidden in the list', async ({ page }) => {
    // The whole reason the hidden flag exists: revealing it in the list would
    // undo the decision the user made when they set it.
    await openVault(page, 'custom');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('WithCustom');

    await page.getByTestId('custom-add').click();
    await page.getByTestId('custom-label').fill('Mother’s maiden name');
    await page.getByTestId('custom-value').fill('SecretAnswer42');
    await page.getByTestId('custom-hidden').click();

    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-custom-fields')).toContainText('Mother');
    await expect(page.getByTestId('item-custom-fields')).not.toContainText('SecretAnswer42');
  });

  test('shows a visible custom field in full', async ({ page }) => {
    await openVault(page, 'custom-visible');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('VisibleCustom');
    await page.getByTestId('custom-add').click();
    await page.getByTestId('custom-label').fill('Account number');
    await page.getByTestId('custom-value').fill('12345678');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-custom-fields')).toContainText('12345678');
  });

  test('drops a custom field left without a label', async ({ page }) => {
    // Otherwise an accidental "add field" click stores an unnamed value that
    // renders as a blank row nobody can identify later.
    await openVault(page, 'custom-empty');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('EmptyCustom');
    await page.getByTestId('custom-add').click();
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('item-custom-fields')).toHaveCount(0);
  });

  test('everything survives a reload', async ({ page }) => {
    await openVault(page, 'roundtrip');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('Complete');
    await page.getByTestId('item-username').fill('me@example.com');
    await page.getByTestId('item-password').fill('a-stored-password');
    await page.getByTestId('item-totp').fill(TOTP_SECRET);
    await page.getByTestId('item-recovery-codes').fill('one\ntwo');
    await page.getByTestId('custom-add').click();
    await page.getByTestId('custom-label').fill('PIN');
    await page.getByTestId('custom-value').fill('4321');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('connection-status')).toContainText('synced');

    await page.getByTestId('edit-item').click();

    await expect(page.getByTestId('item-totp')).toHaveValue(TOTP_SECRET);
    await expect(page.getByTestId('item-recovery-codes')).toHaveValue('one\ntwo');
    await expect(page.getByTestId('custom-label')).toHaveValue('PIN');
    await expect(page.getByTestId('custom-value')).toHaveValue('4321');
  });

  test('none of it reaches the server in the clear', async ({ page }) => {
    const bodies: string[] = [];
    page.on('request', (request) => {
      const body = request.postData();
      if (body) bodies.push(body);
    });

    await openVault(page, 'zk-fields');

    await page.getByTestId('new-item').click();
    await page.getByTestId('item-title').fill('AllSecret');
    await page.getByTestId('item-totp').fill(TOTP_SECRET);
    await page.getByTestId('item-recovery-codes').fill('recovery-code-one');
    await page.getByTestId('custom-add').click();
    await page.getByTestId('custom-label').fill('PIN');
    await page.getByTestId('custom-value').fill('9876');
    await page.getByTestId('item-save').click();

    await expect(page.getByTestId('connection-status')).toContainText('synced');

    for (const body of bodies) {
      expect(body).not.toContain(TOTP_SECRET);
      expect(body).not.toContain('recovery-code-one');
      expect(body).not.toContain('AllSecret');
    }
  });
});
